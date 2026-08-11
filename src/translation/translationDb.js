import { LANGUAGES } from '../config.js';
import { readWorkbook, sheetRows } from '../excel/workbook.js';
import { compactKey, isMeaningful, normalizeText } from '../utils/normalize.js';

const LANGUAGE_HEADER_ALIASES = {
  EN: ['en', 'engels', 'engels (en)', 'english', '(engelse naam)', 'engelse naam'],
  DE: ['de', 'duits', 'duits (de)', 'german'],
  NL: ['nl', 'nederlands', 'nederlands (nl)', 'dutch'],
  FR: ['fr', 'frans', 'frans (fr)', 'french'],
  SE: ['se', 'sv', 'zweeds', 'zweeds (se)', 'swedish'],
  FI: ['fi', 'fins', 'fins (fi)', 'finnish'],
  DK: ['dk', 'deens', 'deens (dk)', 'danish'],
  IT: ['it', 'italiaans', 'italiaans (it)', 'italian'],
  CZ: ['cz', 'tsjechisch', 'tsjechisch (cz)', 'czech'],
  HU: ['hu', 'hongaars', 'hongaars (hu)', 'hungarian'],
  PL: ['pl', 'pools', 'pools (pl)', 'polish'],
  ES: ['es', 'spaans', 'spaans (es)', 'spanish'],
  SK: ['sk', 'slowaaks', 'slowaaks sk', 'slowaaks (sk)', 'slovak']
};

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function headerMatchesAlias(normalizedHeader, alias) {
  const normalizedAlias = normalizeText(alias).replace(/\s+/g, ' ');
  if (normalizedHeader === normalizedAlias) return true;
  if (normalizedAlias.length <= 2) {
    return new RegExp(`(^|[^a-z])${escapeRegExp(normalizedAlias)}([^a-z]|$)`).test(normalizedHeader);
  }
  return normalizedHeader.includes(normalizedAlias);
}

function headerToLanguageCode(headerValue) {
  const normalized = normalizeText(headerValue).replace(/\s+/g, ' ');
  for (const [code, aliases] of Object.entries(LANGUAGE_HEADER_ALIASES)) {
    if (aliases.some((alias) => headerMatchesAlias(normalized, alias))) {
      return code;
    }
  }
  return '';
}

function detectColumns(headerRow) {
  const columns = {};
  for (let c = 0; c < headerRow.length; c += 1) {
    const code = headerToLanguageCode(headerRow[c]);
    if (code && columns[code] == null) columns[code] = c;
  }
  return columns;
}

function rowToTranslations(row, columns) {
  const translations = {};
  for (const language of LANGUAGES) {
    const col = columns[language.code];
    translations[language.code] = col == null ? '' : String(row[col] ?? '').trim();
  }
  return translations;
}

function lookupVariants(text) {
  const raw = String(text ?? '').trim();
  const variants = new Set([raw]);
  if (!raw) return [];

  variants.add(raw.replace(/^ingredients:\s*/i, '').trim());
  variants.add(raw.replace(/\bsoy\b/gi, 'SOYA'));
  variants.add(raw.replace(/\bsoybean(s)?\b/gi, 'SOYA bean$1'));
  variants.add(raw.replace(/\bstabilizer(s)?\b/gi, 'stabiliser$1'));
  variants.add(raw.replace(/\bcolor(s)?\b/gi, 'colour$1'));
  variants.add(raw.replace(/\bflavoring(s)?\b/gi, 'flavouring$1'));
  variants.add(raw.replace(/\bflavor(s)?\b/gi, 'flavour$1'));
  variants.add(raw.replace(/\bhydrolyzed\b/gi, 'hydrolysed'));

  if (/s$/i.test(raw) && raw.length > 3) variants.add(raw.replace(/s$/i, ''));
  if (/ies$/i.test(raw)) variants.add(raw.replace(/ies$/i, 'y'));

  return Array.from(variants).filter(Boolean);
}

function sheetPriority(sheetName) {
  return normalizeText(sheetName) === 'data' ? 0 : 10;
}

export function loadTranslationDb(filePath) {
  const workbook = readWorkbook(filePath);
  const entries = new Map();
  const diagnostics = [];

  for (const sheetName of workbook.SheetNames) {
    const rows = sheetRows(workbook, sheetName);
    if (!rows.length) continue;

    const columns = detectColumns(rows[0]);
    if (columns.EN == null) {
      diagnostics.push(`Sheet "${sheetName}" overgeslagen: geen Engelse kolom gevonden.`);
      continue;
    }

    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r];
      const english = String(row[columns.EN] ?? '').trim();
      if (!isMeaningful(english)) continue;

      const translations = rowToTranslations(row, columns);
      translations.EN ||= english;
      const key = compactKey(english);
      if (!key) continue;

      const nextEntry = {
        key,
        english,
        translations,
        priority: sheetPriority(sheetName),
        source: {
          workbook: filePath,
          sheet: sheetName,
          row: r + 1,
          category: String(row[0] ?? '').trim()
        }
      };

      const existing = entries.get(key);
      if (!existing || nextEntry.priority > (existing.priority || 0)) entries.set(key, nextEntry);
    }
  }

  return {
    filePath,
    entries,
    diagnostics,
    lookup(text) {
      for (const variant of lookupVariants(text)) {
        const key = compactKey(variant);
        const hit = entries.get(key);
        if (hit) return hit;
      }
      return null;
    },
    lookupMany(candidates) {
      for (const candidate of candidates) {
        const hit = this.lookup(candidate);
        if (hit) return hit;
      }
      return null;
    },
    entryList() {
      return Array.from(entries.values())
        .filter((entry) => isMeaningful(entry.english))
        .sort((a, b) => b.english.length - a.english.length);
    }
  };
}
