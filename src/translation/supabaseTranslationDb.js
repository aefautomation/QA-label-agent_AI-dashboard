// Loads the approved translations from the AEF AI Platform database
// (translation_terms + translation_term_values) instead of the SharePoint
// workbook Labels_13_talen.xlsx.
//
// Returns the exact same interface as loadTranslationDb() in translationDb.js —
// entries / diagnostics / lookup / lookupMany / entryList — so every caller
// (translator.js, ingredientDeclaration.js) keeps working unchanged.
//
// The rows were written by scripts/import-translation-db.js using this project's
// own compactKey(), so normalized_key is already the lookup key.
import { createClient } from '@supabase/supabase-js';
import { LANGUAGES } from '../config.js';
import { compactKey, isMeaningful } from '../utils/normalize.js';
import { lookupVariants } from './translationDb.js';

const TERM_TABLE = 'translation_terms';
const VALUE_TABLE = 'translation_term_values';
const SOURCE_LANGUAGE = 'en';
// PostgREST caps rows per response (Supabase default: 1000) regardless of the
// range we ask for. Paginating on the *returned* count instead of the requested
// count keeps this correct whatever that cap is set to.
const PAGE_SIZE = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ISO 639-1 in the database -> the language codes this agent and the DOCX
// templates use. Note SE/DK/CZ are the agent's historical (non-ISO) codes.
const ISO_TO_AGENT_CODE = {
  en: 'EN',
  de: 'DE',
  nl: 'NL',
  fr: 'FR',
  sv: 'SE',
  fi: 'FI',
  da: 'DK',
  it: 'IT',
  cs: 'CZ',
  hu: 'HU',
  pl: 'PL',
  es: 'ES',
  sk: 'SK'
  // 'no' (Norwegian) exists in the database but is not a label language.
};

let cache = null;

function emptyTranslations() {
  return Object.fromEntries(LANGUAGES.map((language) => [language.code, '']));
}

/**
 * Reads a whole table in pages. Advances by the number of rows actually
 * returned and stops on an empty page, so a server-side row cap cannot silently
 * truncate the result.
 */
async function fetchAll(table, applyQuery) {
  const rows = [];
  let from = 0;

  for (;;) {
    const { data, error } = await applyQuery(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Kon niet laden uit ${table}: ${error.message}`);

    const page = data ?? [];
    if (page.length === 0) break;

    rows.push(...page);
    from += page.length;
  }

  return rows;
}

function fetchAllTerms(supabase) {
  return fetchAll(TERM_TABLE, (from, to) =>
    supabase
      .from(TERM_TABLE)
      .select('id, source_text, normalized_key, category, source_category, source_sheet, status')
      .eq('source_language', SOURCE_LANGUAGE)
      .eq('status', 'approved')
      .order('id', { ascending: true })
      .range(from, to)
  );
}

function fetchAllValues(supabase) {
  return fetchAll(VALUE_TABLE, (from, to) =>
    supabase
      .from(VALUE_TABLE)
      .select('term_id, language_code, translated_text')
      .order('id', { ascending: true })
      .range(from, to)
  );
}

export async function loadTranslationDbFromSupabase({ url, serviceRoleKey, useCache = true } = {}) {
  if (useCache && cache && cache.expiresAt > Date.now()) return cache.db;
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase is niet geconfigureerd. Zet SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY.');
  }

  const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const diagnostics = [];

  const [termRows, valueRows] = await Promise.all([fetchAllTerms(supabase), fetchAllValues(supabase)]);

  const valuesByTermId = new Map();
  let ignoredLanguages = new Set();

  for (const row of valueRows) {
    const agentCode = ISO_TO_AGENT_CODE[row.language_code];
    if (!agentCode) {
      ignoredLanguages.add(row.language_code);
      continue;
    }
    if (!isMeaningful(row.translated_text)) continue;

    const bucket = valuesByTermId.get(row.term_id) ?? {};
    bucket[agentCode] = String(row.translated_text).trim();
    valuesByTermId.set(row.term_id, bucket);
  }

  const entries = new Map();

  for (const row of termRows) {
    const english = String(row.source_text ?? '').trim();
    if (!isMeaningful(english)) continue;

    // Trust the stored key, but fall back to recomputing it so a hand-edited
    // row can never become unfindable.
    const key = String(row.normalized_key ?? '').trim() || compactKey(english);
    if (!key) continue;

    const translations = { ...emptyTranslations(), ...(valuesByTermId.get(row.id) ?? {}) };
    translations.EN ||= english;

    entries.set(key, {
      key,
      english,
      translations,
      priority: 10,
      source: {
        workbook: `supabase:${TERM_TABLE}`,
        sheet: row.source_sheet || '',
        row: null,
        category: row.source_category || row.category || ''
      }
    });
  }

  if (entries.size === 0) {
    diagnostics.push(
      'De vertalingendatabase in Supabase is leeg; alle velden vallen terug op AI-research.'
    );
  }
  if (ignoredLanguages.size > 0) {
    // Informational only: the database may hold languages this label does not use.
    console.log(`Talen genegeerd (niet op het etiket): ${[...ignoredLanguages].join(', ')}`);
  }

  const db = {
    filePath: `supabase:${TERM_TABLE}`,
    entries,
    diagnostics,
    lookup(text) {
      for (const variant of lookupVariants(text)) {
        const hit = entries.get(compactKey(variant));
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

  cache = { db, expiresAt: Date.now() + CACHE_TTL_MS };
  return db;
}

export function clearTranslationDbCache() {
  cache = null;
}
