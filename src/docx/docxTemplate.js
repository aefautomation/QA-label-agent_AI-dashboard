// Fills the selected Word label template and applies green/red QA color coding in DOCX XML.
import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { LANGUAGES } from '../config.js';
import { isMeaningful, normalizeText, xmlEscape } from '../utils/normalize.js';

const FILLED_GREEN = '00B050';
const REVIEW_RED = 'FF0000';
const AI_CONFIDENT_PURPLE = '7030A0';

function xmlDecode(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphText(paragraphXml) {
  const matches = paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>/g);
  return Array.from(matches, (match) => (match[1] == null ? '\n' : xmlDecode(match[1])))
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .trim();
}

function firstTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`));
  return match ? match[0] : '';
}

function colorRunProperties(runProperties, color) {
  let rPr = runProperties || '<w:rPr/>';
  rPr = rPr.replace(/<w:color\b[^/>]*(?:\/>|>[\s\S]*?<\/w:color>)/g, '');
  if (rPr.endsWith('/>')) {
    return rPr.replace('/>', `><w:color w:val="${color}"/></w:rPr>`);
  }
  return rPr.replace('</w:rPr>', `<w:color w:val="${color}"/></w:rPr>`);
}

function removeRunProperty(runProperties, tagName) {
  return runProperties.replace(new RegExp(`<${tagName}\\b[^/>]*(?:\\/>|>[\\s\\S]*?<\\/${tagName}>)`, 'g'), '');
}

function addRunProperties(runProperties, innerXml) {
  const rPr = runProperties || '<w:rPr/>';
  if (rPr.endsWith('/>')) {
    return rPr.replace('/>', `>${innerXml}</w:rPr>`);
  }
  return rPr.replace('</w:rPr>', `${innerXml}</w:rPr>`);
}

function styledRunProperties(runProperties, { bold = false, fontSizeHalfPoints } = {}) {
  let rPr = runProperties || '<w:rPr/>';
  if (bold) {
    rPr = removeRunProperty(rPr, 'w:b');
    rPr = removeRunProperty(rPr, 'w:bCs');
  }
  if (fontSizeHalfPoints) {
    rPr = removeRunProperty(rPr, 'w:sz');
    rPr = removeRunProperty(rPr, 'w:szCs');
  }

  const styleXml = [
    bold ? '<w:b/><w:bCs/>' : '',
    fontSizeHalfPoints ? `<w:sz w:val="${fontSizeHalfPoints}"/><w:szCs w:val="${fontSizeHalfPoints}"/>` : ''
  ].join('');

  return styleXml ? addRunProperties(rPr, styleXml) : rPr;
}

function buildRun(originalRunProperties, text, options = {}) {
  const { red = false, color = '', bold = false, fontSizeHalfPoints, preserveWhitespace = false } = options;
  let rPr = styledRunProperties(originalRunProperties, { bold, fontSizeHalfPoints });
  const runColor = red ? REVIEW_RED : color;
  rPr = runColor ? colorRunProperties(rPr, runColor) : rPr;
  const lines = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => {
      const compacted = line.replace(/[ \t]+/g, ' ');
      return preserveWhitespace ? compacted : compacted.trim();
    });
  const textXml = (lines.length ? lines : [''])
    .map((line, index) => `${index ? '<w:br/>' : ''}<w:t xml:space="preserve">${xmlEscape(line)}</w:t>`)
    .join('');
  return `<w:r>${rPr}${textXml}</w:r>`;
}

function buildParagraph(originalParagraphXml, text, options = {}) {
  const { red = false, color = '', bold = false, fontSizeHalfPoints } = typeof options === 'boolean' ? { red: options } : options;
  const pPr = firstTag(originalParagraphXml, 'w:pPr');
  const originalRPr = firstTag(originalParagraphXml, 'w:rPr');
  if (Array.isArray(options.segments) && options.segments.length) {
    const runs = options.segments
      .map((segment) => buildRun(originalRPr, segment.text, { color, preserveWhitespace: true, ...segment }))
      .join('');
    return `<w:p>${pPr}${runs}</w:p>`;
  }
  return `<w:p>${pPr}${buildRun(originalRPr, text, { red, color, bold, fontSizeHalfPoints })}</w:p>`;
}

function replaceFirstParagraph(cellXml, text, options = {}) {
  const paragraph = cellXml.match(/<w:p\b[\s\S]*?<\/w:p>/)?.[0];
  if (!paragraph) {
    return cellXml.replace('</w:tc>', `${buildParagraph('<w:p/>', text, options)}</w:tc>`);
  }
  return cellXml.replace(paragraph, buildParagraph(paragraph, text, options));
}

function replacePlaceholder(text, value) {
  const replacement = String(value || '').trim();
  if (!replacement) return text.replace(/\bX\b\.?/g, '').replace(/\(\s*BBD\*\s*\)/g, '').replace(/\(\s*FO\*\*\s*\)/g, '').trim();
  return text
    .replace(/\bX\b\.?/g, replacement)
    .replace(/\(\s*BBD\*\s*\)/g, replacement)
    .replace(/\(\s*FO\*\*\s*\)/g, replacement)
    .replace(/\s+/g, ' ')
    .trim();
}

function replaceTwoX(text, first, second) {
  let result = text;
  result = result.replace(/\bX\b\.?/, String(first || 'X').trim());
  result = result.replace(/\bX\b\.?/, String(second || 'X').trim());
  return result.replace(/\s+/g, ' ').trim();
}

function formatDecimal(value, decimals = 1) {
  if (!isMeaningful(value)) return '';
  const numeric = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(numeric)) return String(value).replace('.', ',');
  const rounded = Math.round(numeric * 10 ** decimals) / 10 ** decimals;
  const isWhole = Math.abs(rounded - Math.round(rounded)) < 0.000001;
  return (isWhole ? String(Math.round(rounded)) : rounded.toFixed(decimals)).replace('.', ',');
}

function formatEnergy(value) {
  if (!isMeaningful(value)) return '';
  const numeric = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(numeric)) return String(value);
  return String(Math.round(numeric));
}

function isNumericValue(value) {
  return /^-?\d+(?:[.,]\d+)?$/.test(String(value || '').trim());
}

function formatWeight(value) {
  if (!isNumericValue(value)) return '';
  return `${formatDecimal(value, 1)} g`;
}

function formatNutrient(value, key) {
  if (!isMeaningful(value)) return '';
  const numeric = Number(String(value).replace(',', '.'));
  const decimals = key === 'salt' && Number.isFinite(numeric) && Math.abs(numeric) < 1 ? 2 : 1;
  return `${formatDecimal(value, decimals)}g`;
}

function singleContent(spec) {
  const candidates = spec.templateType === 'fisheryFrozen'
    ? [spec.fish?.netWeightWithoutGlaze, spec.logistics?.drainedWeight, spec.logistics?.netWeight]
    : [spec.logistics?.drainedWeight, spec.logistics?.netWeight];
  const netWeight = candidates.find(isNumericValue);
  if (isNumericValue(netWeight)) return formatWeight(netWeight);
  if (isNumericValue(spec.logistics?.netContentMl)) return `${formatDecimal(spec.logistics.netContentMl, 1)} ml`;
  return '';
}

function cartonContent(spec) {
  const unitContent = singleContent(spec);
  const quantityText = String(spec.logistics?.outerCartonQuantity || '').trim();
  const quantity = quantityText.match(/\d+(?:[.,]\d+)?/)?.[0];
  if (quantity && unitContent) return `${quantity} x ${unitContent}`;
  return unitContent;
}

const DRAINED_WEIGHT_PATTERNS = [
  /^abtropfgewicht$/,
  /^netto uitlekgewicht$/,
  /^poids egoutte$/,
  /^avrunnen vikt$/,
  /^valutettu paino$/,
  /^drænet vægt$/,
  /^draenet vaegt$/,
  /^peso sgocciolato$/,
  /^drained weight$/,
  /^odkapane hmotnost(?:i)?$/,
  /^leeresztett suly$/,
  /^waga netto po odsaczeniu$/,
  /^peso escurrido$/,
  /^vypustena hmotnos(?:t)?$/
];

function isDrainedWeightLabel(text) {
  const normalized = normalizeText(text)
    .replace(/\s+\d+(?:[.,]\d+)?\s*(?:g|kg)\s*$/i, '')
    .replace(/:\s*$/, '')
    .trim();
  return DRAINED_WEIGHT_PATTERNS.some((pattern) => pattern.test(normalized));
}

function fillWeightLabel(text, value) {
  const formatted = formatWeight(value);
  const label = String(text || '').trim();
  return formatted ? `${label} ${formatted}` : label;
}

function fillDrainedWeightLabels(text, value) {
  const lines = String(text || '').split('\n');
  let matched = false;
  const filledLines = lines.map((line) => {
    if (!isDrainedWeightLabel(line)) return line;
    matched = true;
    return fillWeightLabel(line, value);
  });
  return matched ? filledLines.join('\n') : '';
}

function bestBeforeReference(spec) {
  if (isMeaningful(spec.storage?.expirationLocation)) return 'see print';
  return spec.storage?.expirationExample || '(BBD*)';
}

function agentDateValue() {
  return `Label Agent / ${new Date().toISOString().slice(0, 10)}`;
}

function specVersionNumber(spec) {
  return String(spec.specificationVersion || '').replace(/^AEF\s+Version\s*/i, '').trim();
}

function fieldText(field, languageCode) {
  return field?.translations?.[languageCode] || field?.translations?.EN || field?.sourceText || '';
}

function fieldRed(field) {
  if (fieldAiConfident(field)) return false;
  return Boolean(field && field.reviewRequired);
}

function fieldAiConfident(field) {
  return Boolean(field?.source?.type && /^openai/i.test(field.source.type) && field.source.confident);
}

function fieldColor(field) {
  return fieldAiConfident(field) ? AI_CONFIDENT_PURPLE : '';
}

function fieldStyle(field) {
  return {
    red: fieldRed(field),
    color: fieldColor(field)
  };
}

function fieldLanguageSegments(field, languageCode) {
  const segments = field?.languageSegments?.[languageCode] || field?.languageSegments?.EN;
  return Array.isArray(segments) ? segments : [];
}

function mergeStyleSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    if (!segment?.text) continue;
    const red = Boolean(segment.red);
    const color = segment.color || '';
    const previous = merged.at(-1);
    if (previous && previous.red === red && (previous.color || '') === color) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment, red, color });
    }
  }
  return merged;
}

function trimSegmentEdges(segments) {
  const trimmed = segments.filter((segment) => segment?.text);
  if (!trimmed.length) return [];
  trimmed[0] = { ...trimmed[0], text: trimmed[0].text.replace(/^\s+/, '') };
  const lastIndex = trimmed.length - 1;
  trimmed[lastIndex] = { ...trimmed[lastIndex], text: trimmed[lastIndex].text.replace(/\s+$/, '') };
  return mergeStyleSegments(trimmed.filter((segment) => segment.text));
}

function replacePlaceholderWithSegments(text, value, replacementSegments, fallbackOptions = {}) {
  const replacement = String(value || '').trim();
  if (!replacement || !Array.isArray(replacementSegments) || !replacementSegments.length) {
    return {
      text: replacePlaceholder(text, replacement),
      red: Boolean(fallbackOptions.red)
    };
  }

  const source = String(text || '');
  const placeholder = source.match(/\bX\b\.?/);
  if (!placeholder) {
    return {
      text: replacePlaceholder(source, replacement),
      red: Boolean(fallbackOptions.red)
    };
  }

  const before = source.slice(0, placeholder.index);
  const after = source.slice(placeholder.index + placeholder[0].length);
  const segments = trimSegmentEdges([
    before ? { text: before, red: false } : null,
    ...replacementSegments.map((segment) => ({
      text: segment.text,
      red: Boolean(segment.red),
      color: segment.color || ''
    })),
    after ? { text: after, red: false } : null
  ]);

  return {
    text: segments.map((segment) => segment.text).join(''),
    segments
  };
}

function inlineLanguageMarkers(text) {
  return Array.from(String(text || '').matchAll(/\((DE|NL|FR|SE|FI|DK|IT|EN|CZ|HU|PL|ES|SK)\)/g), (match) => match[1]);
}

function replaceInlineLanguageHeadings(text, translations) {
  return String(text || '')
    .replace(
      /\((DE|NL|FR|SE|FI|DK|IT|EN|CZ|HU|PL|ES|SK)\)\s*(?:Naam|Name)\.?/g,
      (_match, languageCode) => `(${languageCode}) ${fieldText(translations.productName, languageCode)}`
    )
    .replace(/\.\s*(\((?:DE|NL|FR|SE|FI|DK|IT|EN|CZ|HU|PL|ES|SK)\))/g, '.\n$1');
}

function inlineLanguageHeadingReplacement(text, translations, baseStyle = {}) {
  const prepared = String(text || '').replace(/\.\s*(\((?:DE|NL|FR|SE|FI|DK|IT|EN|CZ|HU|PL|ES|SK)\))/g, '.\n$1');
  const pattern = /\((DE|NL|FR|SE|FI|DK|IT|EN|CZ|HU|PL|ES|SK)\)\s*(?:Naam|Name)\.?/g;
  const segments = [];
  let cursor = 0;

  for (const match of prepared.matchAll(pattern)) {
    if (match.index > cursor) {
      segments.push({ text: prepared.slice(cursor, match.index), ...baseStyle });
    }
    const languageCode = match[1];
    segments.push({
      text: `(${languageCode}) ${fieldText(translations.productName, languageCode)}`,
      ...fieldStyle(translations.productName)
    });
    cursor = match.index + match[0].length;
  }

  if (!segments.length) return { text: prepared, ...baseStyle };
  if (cursor < prepared.length) segments.push({ text: prepared.slice(cursor), ...baseStyle });
  return {
    text: segments.map((segment) => segment.text).join(''),
    segments
  };
}

function fishMode(spec) {
  const method = normalizeText(spec.fish?.productionMethod);
  if (method.includes('farm') || method.includes('aqua') || method.includes('kweek')) return 'aquaculture';
  if (method.includes('fresh') || method.includes('zoet')) return 'freshwater';
  if (method.includes('caught') || method.includes('catch') || method.includes('wild') || method.includes('sea') || method.includes('zout')) return 'saltwater';
  return spec.isFisheryProduct ? 'aquaculture' : '';
}

function headerValueForLabel(label, spec) {
  const normalized = normalizeText(label);
  const values = [
    { test: /^art\.?\s*nr\.?:?$/i, value: spec.articleNumber || '' },
    { test: /^gemaakt door \/ datum:?$/i, value: agentDateValue() },
    { test: /^vertaald door \/ datum:?$/i, value: agentDateValue() },
    { test: /^versie datum specificatie:?$/i, value: spec.specificationVersionDate || new Date().toISOString().slice(0, 10) },
    { test: /^versie nr\.?:?$/i, value: specVersionNumber(spec) },
    { test: /^cr\.?\s*nr\.?:?$/i, value: '' },
    { test: /^gecontroleerd door \/ datum:?$/i, value: '' }
  ];

  for (const field of values) {
    if (field.test.test(normalized)) return field.value;
  }
  return null;
}

function replaceHeaderTableValues(xml, spec) {
  return xml.replace(/<w:tr\b[\s\S]*?<\/w:tr>/g, (rowXml) => {
    const cells = rowXml.match(/<w:tc\b[\s\S]*?<\/w:tc>/g);
    if (!cells || cells.length < 2) return rowXml;

    const patchedCells = [...cells];
    for (let index = 0; index < cells.length - 1; index += 1) {
      const label = paragraphText(cells[index]);
      const value = headerValueForLabel(label, spec);
      if (value == null) continue;

      patchedCells[index] = replaceFirstParagraph(cells[index], label);
      patchedCells[index + 1] = replaceFirstParagraph(cells[index + 1], value, value ? { color: FILLED_GREEN } : {});
    }

    let cellIndex = 0;
    return rowXml.replace(/<w:tc\b[\s\S]*?<\/w:tc>/g, () => patchedCells[cellIndex++]);
  });
}

function createParagraphReplacer({ spec, translations, skipHeaderMetadata = false }) {
  let currentLanguage = 'EN';
  const languageCodes = new Set(LANGUAGES.map((language) => language.code));
  const nutrition = spec.nutrition || {};
  const fishProductionMode = fishMode(spec);
  const nutritionSequence = ['fat', 'saturates', 'carbohydrate', 'sugars', 'protein', 'salt'];
  let nutritionIndex = 0;
  let inCartonBlock = false;
  const bestBeforeValue = bestBeforeReference(spec);
  const frozenOnValue = spec.fish?.dateFirstFreezing || 'FO**';
  const netWeight = spec.fish?.netWeightWithoutGlaze || spec.logistics?.drainedWeight || spec.logistics?.netWeight;
  const directionKeywords = [
    'methode',
    'bereidingswijze',
    'preparation',
    'preparazione',
    'beredning',
    'valmistus',
    'fremstillingsmetode',
    'vyroby',
    'keszitesi',
    'produkcji',
    'preparacion',
    'pripravy'
  ];
  const bestBeforeKeywords = [
    'haltbar',
    'houdbaar',
    'consommer',
    'best before',
    'trvanlivost',
    'megorzi',
    'spozyc',
    'consumir',
    'bedst',
    'bast fore',
    'parasta ennen',
    'consumarsi'
  ];

  return function replace(text) {
    if (!text) return null;
    const normalized = normalizeText(text);
    const markers = inlineLanguageMarkers(text);
    const trailingLanguage = markers.at(-1) || '';
    const applyInlineLanguageState = (replacement) => {
      if (trailingLanguage && !text.trim().startsWith(`(${trailingLanguage})`)) currentLanguage = trailingLanguage;
      return replacement;
    };

    if (normalized.includes('label carton')) {
      inCartonBlock = true;
      return null;
    }

    if (/^(if brand|briefing marketingteksten|invullen door bm private labels)/i.test(text.trim())) {
      inCartonBlock = false;
      return null;
    }

    const languageMatch = text.match(/^\((DE|NL|FR|SE|FI|DK|IT|EN|CZ|HU|PL|ES|SK)\)\s*(.*)$/);
    if (languageMatch && languageCodes.has(languageMatch[1])) {
      currentLanguage = languageMatch[1];
      const productName = fieldText(translations.productName, currentLanguage);
      return {
        text: `(${currentLanguage}) ${productName}`,
        ...fieldStyle(translations.productName)
      };
    }

    if (normalized === 'kj/ kcal' || normalized === 'kj/kcal') {
      return {
        text: `${formatEnergy(nutrition.energyKj)} kJ / ${formatEnergy(nutrition.energyKcal)} kcal`,
        red: false
      };
    }

    if (/^0(?:,0|,00)?g$/i.test(text.trim())) {
      const key = nutritionSequence[nutritionIndex++];
      if (key) return { text: formatNutrient(nutrition[key], key), red: !isMeaningful(nutrition[key]) };
    }

    if (/^(waarschuwingen\.|warning\.)$/i.test(text.trim())) {
      const warning = fieldText(translations.warning, currentLanguage);
      return {
        text: warning,
        ...(warning ? fieldStyle(translations.warning) : { red: false })
      };
    }

    if (/\bX\b/.test(text) && /(zutaten|ingrediënten|ingredients|ingrédients|ingredienser|ainesosat|ingredienti|složení|összetevők|składniki|ingredientes|zloženie)/i.test(text)) {
      const ingredientText = fieldText(translations.ingredients, currentLanguage);
      return replacePlaceholderWithSegments(
        text,
        ingredientText,
        fieldLanguageSegments(translations.ingredients, currentLanguage),
        fieldStyle(translations.ingredients)
      );
    }

    if (/\bX\b/.test(text) && /(herkunft|herkomst|origine|ursprung|alkuperä|oprindelse|origin|původ|származási|pochodzenie|origen|pôvod)/i.test(text)) {
      return {
        text: replacePlaceholder(text, fieldText(translations.origin, currentLanguage)),
        ...fieldStyle(translations.origin)
      };
    }

    if (/\bX\b/.test(text) && directionKeywords.some((keyword) => normalized.includes(keyword))) {
      const direction = fieldText(translations.direction, currentLanguage);
      return applyInlineLanguageState(
        inlineLanguageHeadingReplacement(
          replacePlaceholder(text, direction),
          translations,
          fieldStyle(translations.direction)
        )
      );
    }

    if (/\bX\b|\(BBD\*\)|LIVE/.test(text) && bestBeforeKeywords.some((keyword) => normalized.includes(keyword))) {
      return {
        text: text.replace(/\bX\b\.?/g, bestBeforeValue).replace(/\(BBD\*\)/g, bestBeforeValue).replace(/LIVE/g, bestBeforeValue),
        red: false
      };
    }

    if (/\(FO\*\*\)/.test(text) || /(eingefroren|ingevroren|congelé|nedfryst|pakastuspäivämäärä|dybfrosset|congelato|frozen on|zmrazeno|fagyasztás|zamrożone|congelación|zmrazené)/i.test(text)) {
      return {
        text: text.replace(/\(FO\*\*\)/g, frozenOnValue),
        red: !isMeaningful(spec.fish?.dateFirstFreezing)
      };
    }

    if (/^kweekvis:/i.test(text)) {
      return fishProductionMode === 'aquaculture' ? { text, red: false } : { text: '', red: false };
    }

    if (/^gevangen zoetwatervis:/i.test(text)) {
      if (fishProductionMode !== 'freshwater') return { text: '', red: false };
      return {
        text: replacePlaceholder(text, fieldText(translations.fishingMethod, currentLanguage)),
        ...fieldStyle(translations.fishingMethod)
      };
    }

    if (/^gevangen zoutwatervis:/i.test(text)) {
      if (fishProductionMode !== 'saltwater') return { text: '', red: false };
      return {
        text: replaceTwoX(
          text,
          fieldText(translations.fishingArea, currentLanguage),
          fieldText(translations.fishingMethod, currentLanguage)
        ),
        red: fieldStyle(translations.fishingArea).red || fieldStyle(translations.fishingMethod).red,
        color: fieldStyle(translations.fishingArea).color || fieldStyle(translations.fishingMethod).color || ''
      };
    }

    if (/^(?:\u2026|\.{3})\s*g\s*\/\s*l\s*\/\s*cl\s*\/\s*ml\s*\/\s*kg$/i.test(text.trim())) {
      const content = singleContent(spec);
      return { text: content, red: !content, bold: true, fontSizeHalfPoints: 26 };
    }

    if (/^(?:\u2026|\.{3})\s*g\s*\/\s*kg$/i.test(text.trim())) {
      const content = singleContent(spec);
      return { text: content, red: !content, bold: true, fontSizeHalfPoints: 26 };
    }

    if (/^name:?$/i.test(text.trim()) && inCartonBlock) {
      return { text: `Name: ${spec.legalProduct || fieldText(translations.productName, 'EN')}`.trim(), ...fieldStyle(translations.productName) };
    }

    if (/^content:?$/i.test(text.trim()) && inCartonBlock) {
      const content = cartonContent(spec);
      return { text: `Content: ${content}`.trim(), red: !content };
    }

    if (/^best before date:?$/i.test(text.trim()) && inCartonBlock) {
      return { text: `Best before date: ${bestBeforeValue}`.trim(), red: false };
    }

    if (/^ean:?$/i.test(text.trim())) {
      const ean = inCartonBlock ? spec.logistics?.outerCartonEan || spec.logistics?.ean : spec.logistics?.ean;
      return { text: `EAN: ${ean || ''}`.trim(), red: false };
    }

    if (/^origin:?$/i.test(text.trim()) && inCartonBlock) {
      return { text: `Origin: ${spec.countryOfProduction || ''}`.trim(), red: false };
    }

    if (/^origin:$/i.test(text.trim())) {
      return { text: `Origin: ${spec.countryOfProduction || ''}`.trim(), red: false };
    }

    if (!skipHeaderMetadata && /^art\.\s*nr\.?:?$/i.test(text.trim())) {
      return { text: `Art. nr.: ${spec.articleNumber || ''}`.trim(), red: false };
    }

    if (!skipHeaderMetadata && /^gemaakt door \/ datum:?$/i.test(text.trim())) {
      return { text: `Gemaakt door / datum: ${agentDateValue()}`, red: false };
    }

    if (!skipHeaderMetadata && /^vertaald door \/ datum:?$/i.test(text.trim())) {
      return { text: `Vertaald door / datum: ${agentDateValue()}`, red: false };
    }

    if (!skipHeaderMetadata && /^versie datum specificatie:?$/i.test(text.trim())) {
      return { text: `Versie datum specificatie: ${spec.specificationVersionDate || new Date().toISOString().slice(0, 10)}`, red: false };
    }

    if (!skipHeaderMetadata && /^versie nr\.?:?$/i.test(text.trim())) {
      return { text: `Versie nr.: ${specVersionNumber(spec)}`.trim(), red: false };
    }

    const drainedWeightLabels = fillDrainedWeightLabels(text, spec.logistics?.drainedWeight);
    if (drainedWeightLabels) {
      const drained = spec.logistics?.drainedWeight;
      return { text: drainedWeightLabels, red: !isNumericValue(drained) };
    }

    if (/(net weight \(without glaze\)|nettogewicht \(ohne glasur\)|netto gewicht \(zonder glazering\)|poids net \(sans glaçage\)|netto vikt \(utan glasering\)|nettopaino \(ilman lasitetta\)|net weight|peso neto|masa netto|nettó tömeg)/i.test(text) && text.trim().endsWith(':')) {
      return { text: `${text} ${formatWeight(netWeight)}`.trim(), red: false };
    }

    if (/(netto uitlekgewicht|drænet vægt|waga netto po odsączeniu)/i.test(text) && text.trim().endsWith(':')) {
      const drained = spec.logistics?.drainedWeight;
      return { text: drained ? `${text} ${formatWeight(drained)}` : '', red: false };
    }

    return null;
  };
}

function replaceParagraphs(xml, replacer) {
  return xml.replace(/<w:p\b[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    const text = paragraphText(paragraphXml);
    const replacement = replacer(text);
    if (!replacement) return paragraphXml;
    return buildParagraph(paragraphXml, replacement.text, {
      color: FILLED_GREEN,
      ...replacement
    });
  });
}

export async function fillDocxTemplate({ templatePath, outputPath, spec, translations }) {
  const input = await fs.readFile(templatePath);
  const zip = await JSZip.loadAsync(input);
  const targetParts = Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+)\.xml$/.test(name));

  for (const partName of targetParts) {
    const original = await zip.file(partName).async('string');
    const isHeaderPart = /^word\/header\d+\.xml$/.test(partName);
    const tableAwareXml = isHeaderPart ? replaceHeaderTableValues(original, spec) : original;
    const replacer = createParagraphReplacer({ spec, translations, skipHeaderMetadata: isHeaderPart });
    const patched = replaceParagraphs(tableAwareXml, replacer);
    zip.file(partName, patched);
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  await fs.writeFile(outputPath, buffer);
  return outputPath;
}
