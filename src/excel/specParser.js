// Extracts product facts from the 2. BASIC sheet, tolerating small layout shifts in supplier specs.
import { readWorkbook, sheetRows } from './workbook.js';
import { isMeaningful, normalizeText } from '../utils/normalize.js';
import { splitIngredientDeclarationAndWarnings } from '../translation/ingredientDeclaration.js';

const BASIC_SHEET = '2. BASIC';

function cleanCell(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
}

function rowText(row) {
  return row.map(cleanCell).filter(Boolean).join(' | ');
}

function findRow(rows, matchers, start = 0) {
  const tests = Array.isArray(matchers) ? matchers : [matchers];
  for (let r = start; r < rows.length; r += 1) {
    const normalized = normalizeText(rowText(rows[r]));
    if (tests.every((m) => normalized.includes(normalizeText(m)))) {
      return r;
    }
  }
  return -1;
}

function firstCellMatching(rows, pattern) {
  for (const row of rows) {
    for (const cell of row) {
      const value = cleanCell(cell);
      if (pattern.test(value)) return value;
    }
  }
  return '';
}

function dateFromFilename(filePath) {
  const fileName = String(filePath || '').split(/[\\/]/).pop() || '';
  const ymd = fileName.match(/\b(20\d{2})(\d{2})(\d{2})\b/);
  if (ymd) return `${ymd[1]}-${ymd[2]}-${ymd[3]}`;

  const dmy = fileName.match(/\b(\d{2})(\d{2})(20\d{2})\b/);
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;

  return '';
}

function valueRightOfLabel(rows, labelMatchers, options = {}) {
  const { start = 0, maxOffset = 8 } = options;
  const tests = Array.isArray(labelMatchers) ? labelMatchers : [labelMatchers];
  const rowIndex = findRow(rows, tests, start);
  if (rowIndex === -1) return '';

  const row = rows[rowIndex];
  let labelCol = -1;
  for (let c = 0; c < row.length; c += 1) {
    const text = normalizeText(row[c]);
    if (tests.every((m) => text.includes(normalizeText(m)))) {
      labelCol = c;
      break;
    }
  }

  if (labelCol === -1) {
    labelCol = row.findIndex((cell) => isMeaningful(cell));
  }

  for (let c = labelCol + 1; c <= Math.min(row.length - 1, labelCol + maxOffset); c += 1) {
    if (isMeaningful(row[c])) return cleanCell(row[c]);
  }
  return '';
}

function valueOnRow(rows, rowIndex, label, preferredValueCols = []) {
  if (rowIndex < 0 || rowIndex >= rows.length) return '';
  const row = rows[rowIndex];
  for (const col of preferredValueCols) {
    if (isMeaningful(row[col])) return cleanCell(row[col]);
  }

  const labelNorm = normalizeText(label);
  const labelCol = row.findIndex((cell) => normalizeText(cell).includes(labelNorm));
  if (labelCol !== -1) {
    for (let c = labelCol + 1; c < row.length; c += 1) {
      if (isMeaningful(row[c])) return cleanCell(row[c]);
    }
  }
  return '';
}

function cellAt(rows, rowIndex, colIndex) {
  if (rowIndex < 0 || rowIndex >= rows.length) return '';
  return cleanCell(rows[rowIndex]?.[colIndex]);
}

function findNutritionLabelRow(rows, label) {
  const nutritionStart = findRow(rows, 'NUTRITIONAL VALUE');
  const labelNorm = normalizeText(label);
  for (let r = Math.max(0, nutritionStart); r < rows.length; r += 1) {
    const labelCol = rows[r].findIndex((cell, col) => col <= 3 && normalizeText(cell) === labelNorm);
    if (labelCol !== -1) return { rowIndex: r, labelCol };
    if (r > nutritionStart && normalizeText(rowText(rows[r])).includes('storage advice')) break;
  }
  return { rowIndex: -1, labelCol: -1 };
}

function firstNumericRightOf(row, startCol) {
  for (let c = startCol + 1; c < Math.min(row.length, startCol + 8); c += 1) {
    const value = cleanCell(row[c]);
    if (/^-?\d+(?:[.,]\d+)?$/.test(value)) return { value, col: c };
  }
  return { value: '', col: -1 };
}

function nutritionValue(rows, label) {
  const { rowIndex, labelCol } = findNutritionLabelRow(rows, label);
  if (rowIndex === -1) return '';
  return firstNumericRightOf(rows[rowIndex], labelCol).value;
}

function energyValues(rows) {
  const { rowIndex: energyRow, labelCol } = findNutritionLabelRow(rows, 'Energy');
  if (energyRow === -1) return { kj: '', kcal: '' };

  const kjResult = firstNumericRightOf(rows[energyRow], labelCol);
  const kj = kjResult.value;
  let kcal = '';
  for (let r = energyRow + 1; r < Math.min(rows.length, energyRow + 3); r += 1) {
    const candidate = kjResult.col === -1 ? firstNumericRightOf(rows[r], labelCol).value : cleanCell(rows[r][kjResult.col]);
    const unit = rowText(rows[r]);
    if (candidate && /kcal/i.test(unit)) {
      kcal = candidate;
      break;
    }
  }

  return { kj, kcal };
}

function collectAdditives(rows) {
  const start = findRow(rows, 'ADDITIVES');
  if (start === -1) return [];

  const additives = [];
  for (let r = start + 1; r < rows.length; r += 1) {
    const line = normalizeText(rowText(rows[r]));
    if (!line || line.includes('oil / fat') || line.includes('flavourings') || line.includes('mandatory aspects')) break;
    const eNumber = cleanCell(rows[r][5]);
    const name = cleanCell(rows[r][7]);
    const fn = cleanCell(rows[r][9]);
    if (isMeaningful(eNumber) || isMeaningful(name) || isMeaningful(fn)) {
      additives.push({ eNumber, name, function: fn, row: r + 1 });
    }
  }
  return additives;
}

function allergenRows(rows) {
  const start = findRow(rows, 'ALLERGENS');
  if (start === -1) return [];

  const result = [];
  for (let r = start + 3; r < rows.length; r += 1) {
    const allergen = cleanCell(rows[r][1]);
    if (!isMeaningful(allergen)) {
      if (r > start + 20) break;
      continue;
    }
    if (/^(for single ingredients|some ingredients|expressed as|eu legislation|a quantitative|precautionary)/i.test(allergen)) break;
    result.push({
      allergen,
      intentional: cleanCell(rows[r][3]),
      crossContact: cleanCell(rows[r][9]),
      noCrossContact: cleanCell(rows[r][10]),
      palRemark: cleanCell(rows[r][13]),
      row: r + 1
    });
  }
  return result;
}

function yesish(value) {
  return ['yes', 'ja', '1', 'true', 'y'].includes(normalizeText(value));
}

function inferFisheryProduct(spec) {
  const fishWords = [
    'fish',
    'shrimp',
    'prawn',
    'crustacean',
    'mollusc',
    'squid',
    'octopus',
    'tuna',
    'salmon',
    'cod',
    'pangasius',
    'tilapia',
    'seafood'
  ];
  const text = normalizeText([
    spec.legalProduct,
    spec.description,
    spec.ingredientsDeclaration
  ].join(' '));

  const hasFishData = [
    spec.fish.fao,
    spec.fish.fishingMethod,
    spec.fish.fishingArea,
    spec.fish.fao27Detail,
    spec.fish.fao37Detail
  ].some(isMeaningful);

  return hasFishData || fishWords.some((word) => text.includes(word));
}

function inferFrozen(spec) {
  const text = normalizeText([
    spec.storage.unopenedTemperature,
    spec.storage.unopenedAdvice,
    spec.storage.afterOpeningTemperature,
    spec.storage.afterOpeningAdvice,
    spec.storage.directionForUse,
    spec.fish.dateFirstFreezing,
    spec.fish.defrosted
  ].join(' '));

  return (
    text.includes('-18') ||
    text.includes('frozen') ||
    text.includes('freez') ||
    text.includes('thaw') ||
    text.includes('defrost') ||
    text.includes('diepvries')
  );
}

export function parseSpecification(specPath) {
  const workbook = readWorkbook(specPath);
  const rows = sheetRows(workbook, BASIC_SHEET);

  const energy = energyValues(rows);
  const rawIngredientsDeclaration = valueRightOfLabel(rows, 'INGREDIENT DECLARATION', { maxOffset: 12 });
  const ingredientParts = splitIngredientDeclarationAndWarnings(rawIngredientsDeclaration);
  const specWarning = valueRightOfLabel(rows, 'Warning (if applicable)', { maxOffset: 10 });
  const rawDirectionForUse = valueRightOfLabel(rows, 'Direction for use', { maxOffset: 10 });
  const spec = {
    sourceFile: specPath,
    specificationVersion: firstCellMatching(rows, /AEF Version/i),
    specificationVersionDate: dateFromFilename(specPath),
    supplierNumber: valueRightOfLabel(rows, 'SUPPLIER NUMBER'),
    articleNumber: valueRightOfLabel(rows, 'ARTICLE NUMBER ASIA EXPRESS'),
    supplierName: valueRightOfLabel(rows, 'SUPPLIER NAME'),
    brand: valueRightOfLabel(rows, 'BRAND'),
    supplierArticleNumber: valueRightOfLabel(rows, 'ARTICLE NUMBER SUPPLIER'),
    legalProduct: valueRightOfLabel(rows, 'LEGAL PRODUCT'),
    description: valueRightOfLabel(rows, 'DESCRIPTION'),
    countryOfProduction: valueRightOfLabel(rows, 'COUNTRY OF PRODUCTION'),
    ingredientsDeclaration: ingredientParts.ingredients,
    nutrition: {
      energyKj: energy.kj,
      energyKcal: energy.kcal,
      fat: nutritionValue(rows, 'Fat'),
      saturates: nutritionValue(rows, 'Of which saturates'),
      carbohydrate: nutritionValue(rows, 'Carbohydrates'),
      sugars: nutritionValue(rows, 'Of which sugars'),
      protein: nutritionValue(rows, 'Protein'),
      salt: nutritionValue(rows, 'Salt (=Sodium x 2,5)'),
      fiber: nutritionValue(rows, 'Fiber')
    },
    storage: {
      languagesOnPackaging: valueRightOfLabel(rows, 'Languages on original packaging'),
      expirationLocation: valueRightOfLabel(rows, 'Location of expiration date'),
      expirationExample: valueRightOfLabel(rows, 'Example notation expiration date'),
      lotBatchCode: valueRightOfLabel(rows, 'Lot/Batch/Production number'),
      directionForUseRaw: rawDirectionForUse,
      directionForUse: cleanCell(rawDirectionForUse),
      warning: [specWarning, ingredientParts.warnings].filter(isMeaningful).join(' '),
      unopenedTemperature: valueRightOfLabel(rows, 'Storage temperature (unopened)'),
      unopenedAdvice: valueRightOfLabel(rows, 'Storage advice (unopened)'),
      afterOpeningTemperature: valueRightOfLabel(rows, 'Storage temperature (after opening)'),
      afterOpeningAdvice: valueRightOfLabel(rows, 'Storage advice (after opening)'),
      shelfLifeAfterOpening: valueRightOfLabel(rows, 'Shelf life (after opening)'),
      shelfLifeAfterProduction: valueRightOfLabel(rows, 'Shelf life (after production)'),
      shelfLifeAfterDelivery: valueRightOfLabel(rows, 'Shelf life (after delivery)')
    },
    fish: {
      productionMethod: valueRightOfLabel(rows, 'PRODUCTION METHODE'),
      fishingArea: valueRightOfLabel(rows, 'MOST REPRESENTATIVE FISHING AREA'),
      fao: valueRightOfLabel(rows, 'FAO'),
      fao27Detail: valueRightOfLabel(rows, 'IF FAO NR. 27 NORTH-EAST ATLANTIC'),
      fao37Detail: valueRightOfLabel(rows, 'IF FAO NR. 37 MEDITERRANEAN SEA'),
      fishingMethod: valueRightOfLabel(rows, 'FISHING METHODE'),
      dateFirstFreezing: valueRightOfLabel(rows, 'DEEP FROZEN? DATE FIRST FREEZING'),
      defrosted: valueRightOfLabel(rows, 'HAS THIS PRODUCT BEEN DEFROSTED'),
      netWeightWithoutGlaze: valueRightOfLabel(rows, 'NETTO WEIGHT (WITHOUT GLAZE)')
    },
    logistics: {
      ean: '',
      outerCartonEan: '',
      netWeight: '',
      netContentMl: '',
      drainedWeight: '',
      grossWeight: '',
      outerCartonQuantity: ''
    },
    additives: collectAdditives(rows),
    allergens: allergenRows(rows),
    flags: {
      gmo: valueRightOfLabel(rows, 'GMO?'),
      ionisingRadiation: valueRightOfLabel(rows, 'USE OF IONISING RADIATION?'),
      packagingGasses: valueRightOfLabel(rows, 'PACKED WITH PACKAGING GASSES?'),
      vacuumPacked: valueRightOfLabel(rows, 'VACUUM PACKED?'),
      nanomaterials: valueRightOfLabel(rows, 'USE OF NANOMATERIALS?')
    }
  };

  const logisticStart = findRow(rows, 'Logistical information');
  if (logisticStart !== -1) {
    const singleRow = findRow(rows, 'Single Unit', logisticStart);
    const handlingRow = findRow(rows, 'Handling unit', logisticStart);
    spec.logistics.ean = cellAt(rows, singleRow, 3);
    spec.logistics.outerCartonEan = cellAt(rows, handlingRow, 3);
    spec.logistics.netWeight = cellAt(rows, singleRow, 8);
    spec.logistics.netContentMl = cellAt(rows, singleRow, 9);
    spec.logistics.drainedWeight = cellAt(rows, singleRow, 10);
    spec.logistics.grossWeight = cellAt(rows, singleRow, 11);
    spec.logistics.outerCartonQuantity = valueRightOfLabel(rows, 'Number of products in outer carton', { start: logisticStart, maxOffset: 8 });
  }

  spec.isFrozen = inferFrozen(spec);
  spec.isFisheryProduct = inferFisheryProduct(spec);
  spec.templateType = spec.isFrozen && spec.isFisheryProduct
    ? 'fisheryFrozen'
    : spec.isFrozen
      ? 'frozen'
      : 'normal';
  spec.qaWarnings = [];

  if (!spec.ingredientsDeclaration) spec.qaWarnings.push('Geen ingrediëntendeclaratie gevonden in 2. BASIC.');
  if (!spec.legalProduct) spec.qaWarnings.push('Geen legal product/name gevonden in 2. BASIC.');
  if (yesish(spec.flags.ionisingRadiation)) spec.qaWarnings.push('Ioniserende straling staat op YES; wettelijke tekst moet handmatig worden gecontroleerd.');
  if (yesish(spec.flags.gmo)) spec.qaWarnings.push('GMO staat op YES; EU GMO-vermelding moet handmatig worden gecontroleerd.');
  if (yesish(spec.flags.nanomaterials)) spec.qaWarnings.push('Nanomaterialen staat op YES; EU nano-vermelding moet handmatig worden gecontroleerd.');

  return spec;
}
