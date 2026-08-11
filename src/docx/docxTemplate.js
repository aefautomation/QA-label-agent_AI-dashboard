import fs from 'node:fs/promises';
import JSZip from 'jszip';
import { LANGUAGES } from '../config.js';
import { isMeaningful, normalizeText, xmlEscape } from '../utils/normalize.js';

function xmlDecode(value) {
  return String(value ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function paragraphText(paragraphXml) {
  const matches = paragraphXml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g);
  return Array.from(matches, (match) => xmlDecode(match[1])).join('').replace(/\s+/g, ' ').trim();
}

function firstTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}\\b[\\s\\S]*?<\\/${tagName}>`));
  return match ? match[0] : '';
}

function redRunProperties(runProperties) {
  let rPr = runProperties || '<w:rPr/>';
  rPr = rPr.replace(/<w:color\b[^/>]*(?:\/>|>[\s\S]*?<\/w:color>)/g, '');
  if (rPr.endsWith('/>')) {
    return rPr.replace('/>', '><w:color w:val="FF0000"/></w:rPr>');
  }
  return rPr.replace('</w:rPr>', '<w:color w:val="FF0000"/></w:rPr>');
}

function buildParagraph(originalParagraphXml, text, red = false) {
  const pPr = firstTag(originalParagraphXml, 'w:pPr');
  const originalRPr = firstTag(originalParagraphXml, 'w:rPr');
  const rPr = red ? redRunProperties(originalRPr) : originalRPr;
  const safeText = xmlEscape(String(text ?? '').replace(/\s+/g, ' ').trim());
  return `<w:p>${pPr}<w:r>${rPr}<w:t xml:space="preserve">${safeText}</w:t></w:r></w:p>`;
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

function formatWeight(value) {
  if (!isMeaningful(value)) return '';
  return `${formatDecimal(value, 1)} g`;
}

function fieldText(field, languageCode) {
  return field?.translations?.[languageCode] || field?.translations?.EN || field?.sourceText || '';
}

function fieldRed(field) {
  return Boolean(field && field.reviewRequired);
}

function fishMode(spec) {
  const method = normalizeText(spec.fish?.productionMethod);
  if (method.includes('farm') || method.includes('aqua') || method.includes('kweek')) return 'aquaculture';
  if (method.includes('fresh') || method.includes('zoet')) return 'freshwater';
  if (method.includes('caught') || method.includes('catch') || method.includes('wild') || method.includes('sea') || method.includes('zout')) return 'saltwater';
  return spec.isFisheryProduct ? 'aquaculture' : '';
}

function createParagraphReplacer({ spec, translations }) {
  let currentLanguage = 'EN';
  const languageCodes = new Set(LANGUAGES.map((language) => language.code));
  const nutrition = spec.nutrition || {};
  const fishProductionMode = fishMode(spec);
  const nutritionCounters = {
    decimalOne: 0,
    zeroGram: 0
  };
  const bestBeforeValue = spec.storage?.expirationExample || '(BBD*)';
  const frozenOnValue = spec.fish?.dateFirstFreezing || 'FO**';
  const netWeight = spec.fish?.netWeightWithoutGlaze || spec.logistics?.drainedWeight || spec.logistics?.netWeight;

  return function replace(text) {
    if (!text) return null;
    const languageMatch = text.match(/^\((DE|NL|FR|SE|FI|DK|IT|EN|CZ|HU|PL|ES|SK)\)\s*(.*)$/);
    if (languageMatch && languageCodes.has(languageMatch[1])) {
      currentLanguage = languageMatch[1];
      const productName = fieldText(translations.productName, currentLanguage);
      return {
        text: `(${currentLanguage}) ${productName}`,
        red: fieldRed(translations.productName)
      };
    }

    const normalized = normalizeText(text);

    if (normalized === 'kj/ kcal' || normalized === 'kj/kcal') {
      return {
        text: `${formatEnergy(nutrition.energyKj)} kJ / ${formatEnergy(nutrition.energyKcal)} kcal`,
        red: false
      };
    }

    if (text === '0,0g') {
      nutritionCounters.decimalOne += 1;
      const values = [
        nutrition.fat,
        nutrition.carbohydrate,
        nutrition.sugars
      ];
      const value = values[nutritionCounters.decimalOne - 1];
      if (value != null) return { text: `${formatDecimal(value, 1)}g`, red: false };
    }

    if (text === '0g') {
      nutritionCounters.zeroGram += 1;
      const values = [
        nutrition.saturates,
        nutrition.protein
      ];
      const value = values[nutritionCounters.zeroGram - 1];
      if (value != null) return { text: `${formatDecimal(value, 1)}g`, red: false };
    }

    if (text === '0,00g') {
      return { text: `${formatDecimal(nutrition.salt, 2)}g`, red: false };
    }

    if (/^(waarschuwingen\.|warning\.)$/i.test(text.trim())) {
      const warning = fieldText(translations.warning, currentLanguage);
      return {
        text: warning,
        red: warning ? fieldRed(translations.warning) : false
      };
    }

    if (/\bX\b/.test(text) && /(zutaten|ingrediënten|ingredients|ingrédients|ingredienser|ainesosat|ingredienti|složení|összetevők|składniki|ingredientes|zloženie)/i.test(text)) {
      return {
        text: replacePlaceholder(text, fieldText(translations.ingredients, currentLanguage)),
        red: fieldRed(translations.ingredients)
      };
    }

    if (/\bX\b/.test(text) && /(herkunft|herkomst|origine|ursprung|alkuperä|oprindelse|origin|původ|származási|pochodzenie|origen|pôvod)/i.test(text)) {
      return {
        text: replacePlaceholder(text, fieldText(translations.origin, currentLanguage)),
        red: fieldRed(translations.origin)
      };
    }

    if (/\bX\b/.test(text) && /(methode|bereidingswijze|préparation|beredning|valmistus|fremstillingsmetode|preparation|výroby|készítési|produkcji|preparación|prípravy)/i.test(text)) {
      const direction = fieldText(translations.direction, currentLanguage);
      return {
        text: replacePlaceholder(text, direction),
        red: fieldRed(translations.direction)
      };
    }

    if (/\bX\b|\(BBD\*\)|LIVE/.test(text) && /(haltbar|houdbaar|consommer|bäst före|parasta ennen|bedst før|consumarsi|best before|trvanlivost|megőrzi|spożyć|consumir)/i.test(text)) {
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
        red: fieldRed(translations.fishingMethod)
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
        red: fieldRed(translations.fishingArea) || fieldRed(translations.fishingMethod)
      };
    }

    if (/^(ean:?|ean:?)$/i.test(text.trim())) {
      return { text: `EAN: ${spec.logistics?.ean || ''}`.trim(), red: false };
    }

    if (/^origin:$/i.test(text.trim())) {
      return { text: `Origin: ${spec.countryOfProduction || ''}`.trim(), red: false };
    }

    if (/^art\.nr\.:?$/i.test(text.trim())) {
      return { text: `Art.nr.: ${spec.articleNumber || ''}`.trim(), red: false };
    }

    if (/^gemaakt door \/ datum:?$/i.test(text.trim())) {
      return { text: `Gemaakt door / datum: Label Agent / ${new Date().toISOString().slice(0, 10)}`, red: false };
    }

    if (/^vertaald door \/ datum:?$/i.test(text.trim())) {
      return { text: `Vertaald door / datum: Label Agent / ${new Date().toISOString().slice(0, 10)}`, red: false };
    }

    if (/^versie datum specificatie:?$/i.test(text.trim())) {
      return { text: `Versie datum specificatie: ${new Date().toISOString().slice(0, 10)}`, red: false };
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
    return buildParagraph(paragraphXml, replacement.text, replacement.red);
  });
}

export async function fillDocxTemplate({ templatePath, outputPath, spec, translations }) {
  const input = await fs.readFile(templatePath);
  const zip = await JSZip.loadAsync(input);
  const replacer = createParagraphReplacer({ spec, translations });
  const targetParts = Object.keys(zip.files).filter((name) => /^word\/(document|header\d+|footer\d+)\.xml$/.test(name));

  for (const partName of targetParts) {
    const original = await zip.file(partName).async('string');
    const patched = replaceParagraphs(original, replacer);
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
