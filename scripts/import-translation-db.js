// Imports Labels_13_talen.xlsx into the AEF AI Platform Supabase tables
// (translation_terms + translation_term_values).
//
// Lives in the agent project on purpose: it reuses the agent's own compactKey()
// so the normalized_key written here is byte-for-byte the key the agent looks
// terms up by. Any other implementation risks silent duplicates.
//
// Usage:
//   node scripts/import-translation-db.js <path-to-xlsx> [--apply] [--limit=N]
//
// Without --apply it is a dry run: it reports exactly what it would write and
// touches nothing.
//
// Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY
// (only needed with --apply).

import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { readWorkbook, sheetRows } from '../src/excel/workbook.js';
import { compactKey, isMeaningful, normalizeText } from '../src/utils/normalize.js';

// Workbook column code -> ISO 639-1. The workbook (and the agent) use SE/DK/CZ,
// which are country codes, not language codes; Supabase stores ISO only.
const COLUMN_TO_ISO = {
  EN: 'en',
  DE: 'de',
  NL: 'nl',
  FR: 'fr',
  SE: 'sv',
  FI: 'fi',
  DK: 'da',
  IT: 'it',
  CZ: 'cs',
  HU: 'hu',
  PL: 'pl',
  ES: 'es',
  SK: 'sk',
  NO: 'no'
};

const LANGUAGE_HEADER_ALIASES = {
  EN: ['engels (en)', '(engelse naam)', 'engelse naam', 'engels', 'english', 'en'],
  DE: ['duits (de)', 'duits', 'german', 'de'],
  NL: ['nederlands (nl)', 'nederlands', 'dutch', 'nl'],
  FR: ['frans (fr)', 'frans', 'french', 'fr'],
  SE: ['zweeds (se)', 'zweeds', 'swedish', 'se', 'sv'],
  FI: ['fins (fi)', 'fins', 'finnish', 'fi'],
  DK: ['deens (dk)', 'deens', 'danish', 'dk'],
  IT: ['italiaans (it)', 'italiaans', 'italian', 'it'],
  CZ: ['tsjechisch (cz)', 'tsjechisch', 'czech', 'cz'],
  HU: ['hongaars (hu)', 'hongaars', 'hungarian', 'hu'],
  PL: ['pools (pl)', 'pools', 'polish', 'pl'],
  ES: ['spaans (es)', 'spaans', 'spanish', 'es'],
  SK: ['slowaaks (sk)', 'slowaaks sk', 'slowaaks', 'slovak', 'sk'],
  NO: ['noors (no)', 'noors', 'norwegian', 'no']
};

/** Dutch workbook category -> platform category (translation_terms.category). */
function mapCategory(sourceCategory) {
  const text = normalizeText(sourceCategory);

  // Fishery first: "Etiket sjabloon vis" must not fall into the generic
  // "etiket sjabloon" bucket.
  if (text.includes('vis')) return 'fishery';
  if (text.startsWith('ingredient') || text.startsWith('additiev') || text.startsWith('allergen')) {
    return 'ingredient';
  }
  if (text.startsWith('product omschrijving') || text.startsWith('productnaam')) return 'legal_product';
  if (text.startsWith('bereid') || text.startsWith('bereidng') || text.includes('openen van verpakking')) {
    return 'preparation';
  }
  if (text.startsWith('opslag')) return 'preparation';
  if (text.startsWith('herkomst')) return 'origin';
  if (text.startsWith('waarschuwing') || text === 'w') return 'warning';

  return 'general';
}

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

function headerToColumnCode(headerValue) {
  const normalized = normalizeText(headerValue).replace(/\s+/g, ' ');
  for (const [code, aliases] of Object.entries(LANGUAGE_HEADER_ALIASES)) {
    if (aliases.some((alias) => headerMatchesAlias(normalized, alias))) return code;
  }
  return '';
}

function detectColumns(headerRow) {
  const columns = {};
  for (let c = 0; c < headerRow.length; c += 1) {
    const code = headerToColumnCode(headerRow[c]);
    if (code && columns[code] == null) columns[code] = c;
  }
  return columns;
}

// Same rule as the agent's translationDb.js: the "data" sheet is legacy and
// loses against the maintained sheets.
function sheetPriority(sheetName) {
  return normalizeText(sheetName) === 'data' ? 0 : 10;
}

/**
 * The "data" sheet is a scratch sheet, not a translation source:
 *  - its first column holds the English name AND is read as the English column,
 *    so its bottom rows (where column 0 is a language code like "EN"/"DU"/"NL"
 *    and column 1 is the word "Ingredients:") import as corrupt terms;
 *  - two of its rows have Hungarian and Czech swapped;
 *  - column 0 and column 1 disagree on the English term ("whey protein powder"
 *    vs "WHEY"), so even its clean-looking rows are unreliable;
 *  - all but two of its glossary terms already exist in the maintained sheets.
 *
 * It is therefore skipped unless --include-data-sheet is passed. Note the agent
 * itself does still read it; see the note in the import report.
 */
function isLegacySheet(sheetName) {
  return sheetPriority(sheetName) === 0;
}

export function collectTerms(filePath, { includeLegacySheet = false } = {}) {
  const workbook = readWorkbook(filePath);
  const terms = new Map();
  const stats = {
    sheets: [],
    skippedRows: 0,
    emptyEnglish: 0,
    duplicatesMerged: 0,
    valuesByLanguage: {},
    categories: {},
    sourceCategories: {}
  };

  for (const sheetName of workbook.SheetNames) {
    const rows = sheetRows(workbook, sheetName);
    const sheetStat = { sheet: sheetName, rows: rows.length, imported: 0, skipped: 0, columns: [] };

    if (!rows.length) {
      stats.sheets.push(sheetStat);
      continue;
    }

    if (!includeLegacySheet && isLegacySheet(sheetName)) {
      sheetStat.skipped = Math.max(0, rows.length - 1);
      sheetStat.note = 'legacy scratch sheet — skipped';
      stats.sheets.push(sheetStat);
      continue;
    }

    const columns = detectColumns(rows[0]);
    sheetStat.columns = Object.keys(columns);

    if (columns.EN == null) {
      sheetStat.skipped = rows.length - 1;
      sheetStat.note = 'no English column — skipped (same as the agent)';
      stats.sheets.push(sheetStat);
      continue;
    }

    for (let r = 1; r < rows.length; r += 1) {
      const row = rows[r];
      const english = String(row[columns.EN] ?? '').trim();

      if (!isMeaningful(english)) {
        stats.emptyEnglish += 1;
        sheetStat.skipped += 1;
        continue;
      }

      const key = compactKey(english);
      if (!key) {
        stats.skippedRows += 1;
        sheetStat.skipped += 1;
        continue;
      }

      // On the "data" sheet column 0 holds the English name, not a category.
      const sourceCategory = sheetPriority(sheetName) === 0 ? '' : String(row[0] ?? '').trim();
      const category = mapCategory(sourceCategory);

      const values = {};
      for (const [columnCode, columnIndex] of Object.entries(columns)) {
        const iso = COLUMN_TO_ISO[columnCode];
        if (!iso) continue;

        const text = String(row[columnIndex] ?? '').trim();
        if (!isMeaningful(text)) continue;
        values[iso] = text;
      }
      values.en ||= english;

      // Identity is the normalized key alone — the agent's lookup ignores the
      // category, and including it would create rival rows for the same term.
      const existing = terms.get(key);
      const priority = sheetPriority(sheetName);

      if (existing) {
        stats.duplicatesMerged += 1;
        // Higher priority wins, matching the agent's lookup precedence.
        if (priority > existing.priority) {
          existing.priority = priority;
          existing.sourceText = english;
          existing.sourceCategory = sourceCategory;
          existing.sourceSheet = sheetName;
          existing.values = { ...existing.values, ...values };
        } else {
          existing.values = { ...values, ...existing.values };
        }
        // A concrete category always beats "general" (the legacy "data" sheet
        // carries no category at all).
        if (existing.category === 'general' && category !== 'general') {
          existing.category = category;
          existing.sourceCategory = sourceCategory;
        }
        continue;
      }

      terms.set(key, {
        sourceLanguage: 'en',
        sourceText: english,
        normalizedKey: key,
        category,
        sourceCategory,
        sourceSheet: sheetName,
        priority,
        values
      });
      sheetStat.imported += 1;
    }

    stats.sheets.push(sheetStat);
  }

  for (const term of terms.values()) {
    stats.categories[term.category] = (stats.categories[term.category] || 0) + 1;
    const label = term.sourceCategory || '(none)';
    stats.sourceCategories[label] = (stats.sourceCategories[label] || 0) + 1;
    for (const iso of Object.keys(term.values)) {
      stats.valuesByLanguage[iso] = (stats.valuesByLanguage[iso] || 0) + 1;
    }
  }

  return { terms: [...terms.values()], stats };
}

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Writes the terms in bulk. Both tables have a unique index that matches the
 * identity used here, so a re-import updates in place instead of duplicating:
 *   translation_terms       unique (source_language, normalized_key)
 *   translation_term_values unique (term_id, language_code)
 */
async function apply(terms) {
  const { createClient } = await import('@supabase/supabase-js');
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Set SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY.');
  }

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const now = new Date().toISOString();
  const result = { termsWritten: 0, valuesWritten: 0, errors: [] };
  const termIdByKey = new Map();

  const termRows = terms.map((term) => ({
    source_language: term.sourceLanguage,
    source_text: term.sourceText,
    normalized_key: term.normalizedKey,
    category: term.category,
    source_category: term.sourceCategory || null,
    source_sheet: term.sourceSheet,
    status: 'approved',
    // Imported from the approved workbook: no individual QA approver.
    approved_by: null,
    approved_at: now,
    updated_at: now
  }));

  for (const [index, batch] of chunk(termRows, 500).entries()) {
    const { data, error } = await supabase
      .from('translation_terms')
      .upsert(batch, { onConflict: 'source_language,normalized_key' })
      .select('id, source_language, normalized_key');

    if (error) {
      result.errors.push(`termen batch ${index + 1}: ${error.message}`);
      continue;
    }

    for (const row of data ?? []) {
      termIdByKey.set(`${row.source_language}|${row.normalized_key}`, row.id);
    }
    result.termsWritten += data?.length ?? 0;
    console.log(`  termen: ${result.termsWritten}/${termRows.length}`);
  }

  const valueRows = [];
  for (const term of terms) {
    const termId = termIdByKey.get(`${term.sourceLanguage}|${term.normalizedKey}`);
    if (!termId) {
      result.errors.push(`geen term-id voor "${term.normalizedKey}"`);
      continue;
    }

    for (const [languageCode, translatedText] of Object.entries(term.values)) {
      valueRows.push({
        term_id: termId,
        language_code: languageCode,
        translated_text: translatedText,
        // From the approved workbook, so trusted by definition.
        confidence_source: 'database',
        approved_by: null,
        approved_at: now,
        updated_at: now
      });
    }
  }

  for (const [index, batch] of chunk(valueRows, 1000).entries()) {
    const { error, count } = await supabase
      .from('translation_term_values')
      .upsert(batch, { onConflict: 'term_id,language_code', count: 'exact' });

    if (error) {
      result.errors.push(`vertalingen batch ${index + 1}: ${error.message}`);
      continue;
    }

    result.valuesWritten += count ?? batch.length;
    console.log(`  vertalingen: ${result.valuesWritten}/${valueRows.length}`);
  }

  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const filePath = args.find((arg) => !arg.startsWith('--'));
  const shouldApply = args.includes('--apply');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : 0;

  if (!filePath) {
    console.error('Gebruik: node scripts/import-translation-db.js <xlsx> [--apply] [--limit=N]');
    process.exit(1);
  }

  const includeLegacySheet = args.includes('--include-data-sheet');
  const { terms, stats } = collectTerms(filePath, { includeLegacySheet });
  const selected = limit > 0 ? terms.slice(0, limit) : terms;

  console.log(`\nBestand: ${filePath}`);
  console.log(`\nPER SHEET`);
  for (const sheet of stats.sheets) {
    console.log(
      `  ${sheet.sheet.padEnd(34)} rijen=${String(sheet.rows).padStart(5)} nieuw=${String(sheet.imported).padStart(5)} overgeslagen=${String(sheet.skipped).padStart(4)} talen=${sheet.columns.length}${sheet.note ? `  (${sheet.note})` : ''}`
    );
  }

  console.log(`\nTOTAAL`);
  console.log(`  unieke termen        : ${terms.length}`);
  console.log(`  samengevoegde dubbele: ${stats.duplicatesMerged}`);
  console.log(`  lege/onbruikbare EN  : ${stats.emptyEnglish}`);
  console.log(`  vertalingen totaal   : ${Object.values(stats.valuesByLanguage).reduce((a, b) => a + b, 0)}`);

  console.log(`\nPER TAAL`);
  for (const [iso, count] of Object.entries(stats.valuesByLanguage).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${iso.padEnd(4)} ${count}`);
  }

  console.log(`\nPLATFORM-CATEGORIE`);
  for (const [category, count] of Object.entries(stats.categories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${category.padEnd(14)} ${count}`);
  }

  console.log(`\nOORSPRONKELIJKE CATEGORIE -> PLATFORM`);
  for (const [sourceCategory, count] of Object.entries(stats.sourceCategories).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${sourceCategory.padEnd(28)} -> ${mapCategory(sourceCategory).padEnd(14)} ${count}`);
  }

  if (!includeLegacySheet) {
    // Report what the skipped scratch sheet would have added, so QA can decide
    // whether any of it belongs in the maintained sheets.
    const withLegacy = collectTerms(filePath, { includeLegacySheet: true });
    const known = new Set(terms.map((term) => term.normalizedKey));
    const onlyInLegacy = withLegacy.terms.filter((term) => !known.has(term.normalizedKey));

    console.log(`\nOVERGESLAGEN "data"-SHEET`);
    console.log(`  termen die alleen daar staan: ${onlyInLegacy.length}`);
    for (const term of onlyInLegacy) {
      console.log(`    "${term.sourceText.slice(0, 40)}"  nl="${(term.values.nl || '').slice(0, 26)}"`);
    }
  }

  console.log(`\nVOORBEELDEN`);
  for (const term of selected.slice(0, 5)) {
    console.log(`  "${term.sourceText.slice(0, 46)}"`);
    console.log(`    key=${term.normalizedKey.slice(0, 46)}`);
    console.log(`    ${term.category} / ${term.sourceCategory || '-'} / talen=${Object.keys(term.values).length}`);
    console.log(`    nl="${(term.values.nl || '').slice(0, 46)}"  de="${(term.values.de || '').slice(0, 40)}"`);
  }

  if (!shouldApply) {
    console.log(`\nDRY RUN — er is niets geschreven. Voeg --apply toe om te importeren.`);
    return;
  }

  console.log(`\n${selected.length} termen wegschrijven naar Supabase...`);
  const result = await apply(selected);
  console.log(`\nKLAAR`);
  console.log(`  termen weggeschreven: ${result.termsWritten}`);
  console.log(`  vertalingen         : ${result.valuesWritten}`);
  if (result.errors.length) {
    console.log(`  FOUTEN (${result.errors.length}):`);
    for (const error of result.errors.slice(0, 20)) console.log(`    ${error}`);
  }
}

// Only run when executed directly, so `collectTerms` can be imported for
// analysis and tests without triggering the CLI.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
