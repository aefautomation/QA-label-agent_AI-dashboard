// Loads the approved translations from the AEF AI Platform database
// (translation_terms + translation_term_values) instead of the SharePoint
// workbook Labels_13_talen.xlsx.
//
// Returns the exact same interface as loadTranslationDb() in translationDb.js —
// entries / diagnostics / lookup / lookupMany / entryList — so every caller
// (translator.js, ingredientDeclaration.js) keeps working unchanged.
//
// Reading goes through the `translation_terms_wide` view: one row per term with a
// column per language, which is the shape this agent and the DOCX templates use
// anyway. That turns ~25 paginated requests into 2. When the view is absent (a
// deployment that runs ahead of its migration) it falls back to joining the two
// normalised tables in memory.
//
// The rows were written by scripts/import-translation-db.js using this project's
// own compactKey(), so normalized_key is already the lookup key.
import { createClient } from '@supabase/supabase-js';
import { LANGUAGES } from '../config.js';
import { AGENT_TO_ISO, ISO_TO_AGENT } from '../utils/languages.js';
import { compactKey, isMeaningful } from '../utils/normalize.js';
import { lookupVariants } from './translationDb.js';

const WIDE_VIEW = 'translation_terms_wide';
const TERM_TABLE = 'translation_terms';
const VALUE_TABLE = 'translation_term_values';
const SOURCE_LANGUAGE = 'en';
// PostgREST caps rows per response (Supabase default: 1000) regardless of the
// range we ask for. Paginating on the *returned* count instead of the requested
// count keeps this correct whatever that cap is set to.
const PAGE_SIZE = 1000;
const CACHE_TTL_MS = 5 * 60 * 1000;

let cache = null;

function emptyTranslations() {
  return Object.fromEntries(LANGUAGES.map((language) => [language.code, '']));
}

/**
 * Reads a whole table or view in pages. Advances by the number of rows actually
 * returned and stops on an empty page, so a server-side row cap cannot silently
 * truncate the result.
 */
async function fetchAll(label, applyQuery) {
  const rows = [];
  let from = 0;

  for (;;) {
    const { data, error } = await applyQuery(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Kon niet laden uit ${label}: ${error.message}`);

    const page = data ?? [];
    if (page.length === 0) break;

    rows.push(...page);
    from += page.length;
  }

  return rows;
}

/** Builds one entry from a wide-view row. */
function entryFromWideRow(row) {
  const english = String(row.source_text ?? '').trim();
  if (!isMeaningful(english)) return null;

  const key = String(row.normalized_key ?? '').trim() || compactKey(english);
  if (!key) return null;

  const translations = emptyTranslations();
  for (const [iso, agentCode] of Object.entries(ISO_TO_AGENT)) {
    const value = row[iso];
    if (isMeaningful(value)) translations[agentCode] = String(value).trim();
  }
  translations.EN ||= english;

  return {
    key,
    english,
    translations,
    priority: 10,
    source: {
      workbook: `supabase:${WIDE_VIEW}`,
      sheet: row.source_sheet || '',
      row: null,
      category: row.source_category || row.category || ''
    }
  };
}

async function loadFromWideView(supabase) {
  const rows = await fetchAll(WIDE_VIEW, (from, to) =>
    supabase
      .from(WIDE_VIEW)
      .select('*')
      .eq('source_language', SOURCE_LANGUAGE)
      .eq('status', 'approved')
      .order('id', { ascending: true })
      .range(from, to)
  );

  const entries = new Map();
  for (const row of rows) {
    const entry = entryFromWideRow(row);
    if (entry) entries.set(entry.key, entry);
  }

  return entries;
}

/** Fallback: join translation_terms and translation_term_values in memory. */
async function loadFromNormalizedTables(supabase) {
  const [termRows, valueRows] = await Promise.all([
    fetchAll(TERM_TABLE, (from, to) =>
      supabase
        .from(TERM_TABLE)
        .select('id, source_text, normalized_key, category, source_category, source_sheet, status')
        .eq('source_language', SOURCE_LANGUAGE)
        .eq('status', 'approved')
        .order('id', { ascending: true })
        .range(from, to)
    ),
    fetchAll(VALUE_TABLE, (from, to) =>
      supabase
        .from(VALUE_TABLE)
        .select('term_id, language_code, translated_text')
        .order('id', { ascending: true })
        .range(from, to)
    )
  ]);

  const valuesByTermId = new Map();
  const ignoredLanguages = new Set();

  for (const row of valueRows) {
    const agentCode = ISO_TO_AGENT[row.language_code];
    if (!agentCode) {
      ignoredLanguages.add(row.language_code);
      continue;
    }
    if (!isMeaningful(row.translated_text)) continue;

    const bucket = valuesByTermId.get(row.term_id) ?? {};
    bucket[agentCode] = String(row.translated_text).trim();
    valuesByTermId.set(row.term_id, bucket);
  }

  if (ignoredLanguages.size > 0) {
    console.log(`Talen genegeerd (niet op het etiket): ${[...ignoredLanguages].join(', ')}`);
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

  return entries;
}

function isMissingRelation(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return message.includes('could not find the table') || message.includes('does not exist');
}

export async function loadTranslationDbFromSupabase({ url, serviceRoleKey, useCache = true } = {}) {
  if (useCache && cache && cache.expiresAt > Date.now()) return cache.db;
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase is niet geconfigureerd. Zet SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY.');
  }

  const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
  const diagnostics = [];
  let entries;
  let readVia = WIDE_VIEW;

  try {
    entries = await loadFromWideView(supabase);
  } catch (error) {
    if (!isMissingRelation(error)) throw error;

    // The view is part of a later migration; keep running on the tables.
    console.warn(
      `View ${WIDE_VIEW} niet gevonden; teruggevallen op ${TERM_TABLE}/${VALUE_TABLE}. Draai migratie 20260818100000 voor de snellere leesroute.`
    );
    entries = await loadFromNormalizedTables(supabase);
    readVia = `${TERM_TABLE}+${VALUE_TABLE}`;
  }

  if (entries.size === 0) {
    diagnostics.push(
      'De vertalingendatabase in Supabase is leeg; alle velden vallen terug op AI-research.'
    );
  }

  const db = {
    filePath: `supabase:${readVia}`,
    readVia,
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

// Kept for callers that only need the code mapping.
export { AGENT_TO_ISO, ISO_TO_AGENT };
