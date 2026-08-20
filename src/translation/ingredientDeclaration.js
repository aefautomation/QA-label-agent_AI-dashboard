// Builds ingredient declarations from trusted database terminology and marks unknown parts for review.
import { LANGUAGES } from '../config.js';
import { compactKey, withDecimalComma } from '../utils/normalize.js';
import { hasTranslationOptions } from './translationOptions.js';
import { ingredientNames, parseIngredientParts } from './ingredientParts.js';
import { translateIngredientTermsWithOpenAi } from './openaiFallback.js';

const INGREDIENT_PREFIX = /^ingredients:\s*/i;
const AI_CONFIDENT_PURPLE = '7030A0';
const DATABASE_CHOICE_YELLOW = 'BF8F00';

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}

export function stripIngredientPrefix(text) {
  return String(text || '').replace(INGREDIENT_PREFIX, '').trim();
}

export function splitIngredientDeclarationAndWarnings(rawText) {
  let ingredients = stripIngredientPrefix(rawText);
  const warnings = [];

  ingredients = ingredients.replace(
    /\bE\s*\d+[a-z]?(?:\s*(?:,|and)\s*E\s*\d+[a-z]?)*\s+may\s+have\s+an\s+adverse\s+effect\s+on\s+activity\s+and\s+attention\s+(?:in|of)\s+children\.?/gi,
    (match) => {
      warnings.push(match.trim().replace(/\s+/g, ' '));
      return '';
    }
  );

  ingredients = ingredients
    .replace(/\s+\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .replace(/[,\s]+$/g, '')
    .trim();

  return {
    ingredients,
    warnings: warnings.join(' ')
  };
}

function termVariants(term) {
  const raw = String(term || '').trim();
  return unique([
    raw,
    raw.replace(/\bsoy\b/gi, 'SOYA'),
    raw.replace(/\bsoybean(s)?\b/gi, 'SOYA bean$1'),
    raw.replace(/\bstabilizer(s)?\b/gi, 'stabiliser$1'),
    raw.replace(/\bcolor(s)?\b/gi, 'colour$1'),
    raw.replace(/\bflavoring(s)?\b/gi, 'flavouring$1'),
    raw.replace(/\bflavor(s)?\b/gi, 'flavour$1'),
    raw.replace(/\bhydrolyzed\b/gi, 'hydrolysed'),
    /s$/i.test(raw) && raw.length > 3 ? raw.replace(/s$/i, '') : '',
    /ies$/i.test(raw) ? raw.replace(/ies$/i, 'y') : ''
  ]);
}

function mergeSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    if (!segment?.text) continue;
    const red = Boolean(segment.red);
    const color = segment.color || '';
    const tone = segment.tone || '';
    const term = segment.term || '';
    const previous = merged.at(-1);
    // Merge only when the identity is the same, and carry that identity along.
    //
    // Both halves matter to the platform. Dropping tone/term here made every
    // marked word unopenable, because the platform links a translated word back
    // to its English term through `term`. And merging on red+color alone glued
    // an approved database term (red=false, no color) into the plain text next
    // to it, so it stopped existing as a separate word entirely.
    const sameIdentity =
      previous &&
      previous.red === red &&
      (previous.color || '') === color &&
      (previous.tone || '') === tone &&
      (previous.term || '') === term;
    if (sameIdentity) {
      previous.text += segment.text;
    } else {
      merged.push({ text: segment.text, red, color, tone, term });
    }
  }
  return merged;
}

function segmentsToText(segments) {
  return segments.map((segment) => segment.text).join('').replace(/\s+([,;:)])/g, '$1').replace(/([(])\s+/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

/**
 * An ingredient name resolved against the approved database, then the AI.
 *
 * The order is the whole point of the colour coding: the database is trusted
 * (green), an AI proposal never is (purple when it is confident, red when it is
 * not), and a name nothing could resolve stays red with its English text so QA
 * sees exactly what is missing.
 */
function resolveIngredientName(name, translationDb, aiTerms) {
  const databaseHit = translationDb.lookupMany(termVariants(name));
  if (databaseHit) {
    return { tone: 'green', entry: databaseHit, term: name };
  }

  for (const variant of termVariants(name)) {
    const aiTerm = aiTerms.get(compactKey(variant));
    if (aiTerm) {
      return { tone: aiTerm.confident ? 'purple' : 'red', aiTerm, term: name };
    }
  }

  // No database hit and no proposal. Still a term rather than an anonymous
  // stretch of text, so QA can open it and fill it in.
  return { tone: 'red', term: name };
}

/** AI proposals by normalised key, so a spelling variant still finds them. */
function indexAiTerms(termTranslations) {
  const index = new Map();
  for (const [term, value] of Object.entries(termTranslations || {})) {
    if (!value) continue;
    for (const variant of termVariants(term)) index.set(compactKey(variant), value);
  }
  return index;
}

function translationForResolved(resolved, languageCode) {
  if (resolved.entry) {
    const translations = resolved.entry.translations || {};
    return String(
      translations[languageCode] || translations.EN || resolved.entry.english || resolved.term
    ).trim();
  }
  if (resolved.aiTerm) {
    const translations = resolved.aiTerm.translations || {};
    return String(translations[languageCode] || translations.EN || resolved.term).trim();
  }
  return resolved.term;
}

/**
 * Builds one language from the resolved parts.
 *
 * Fixed parts are copied verbatim, so percentages and E-numbers keep their place
 * next to the ingredient they belong to without ever being translated.
 */
function segmentsFromResolvedParts(parts, languageCode) {
  const segments = [];

  for (const part of parts) {
    if (part.kind === 'fixed') {
      // Where the percentages live, so this is where the decimal comma lands.
      segments.push({ text: withDecimalComma(part.text), red: false, color: '', tone: '', term: '' });
      continue;
    }

    const resolved = part.resolved;
    const value = translationForResolved(resolved, languageCode);
    // Judged per language: a term can be a single word in Dutch and a choice of
    // three in French, and only the French line needs picking.
    const tone = resolved.tone === 'green' && hasTranslationOptions(value) ? 'yellow' : resolved.tone;

    segments.push({
      text: withDecimalComma(value),
      red: tone === 'red',
      color: tone === 'purple' ? AI_CONFIDENT_PURPLE : tone === 'yellow' ? DATABASE_CHOICE_YELLOW : '',
      tone,
      term: resolved.term
    });
  }

  return mergeSegments(segments);
}

function buildDatabaseTermTranslationResult(sourceText, translationDb, termTranslations = {}) {
  const aiTerms = indexAiTerms(termTranslations);
  const parts = parseIngredientParts(sourceText).map((part) =>
    part.kind === 'text'
      ? { ...part, resolved: resolveIngredientName(part.text, translationDb, aiTerms) }
      : part
  );

  const translations = {};
  const languageSegments = {};

  for (const language of LANGUAGES) {
    const segments = segmentsFromResolvedParts(parts, language.code);
    translations[language.code] = segmentsToText(segments);
    languageSegments[language.code] = segments;
  }

  return { translations, languageSegments };
}

/** Every stored translation with its decimals written the label's way. */
function withDecimalCommaValues(translations) {
  return Object.fromEntries(
    Object.entries(translations || {}).map(([code, value]) => [code, withDecimalComma(value)])
  );
}

function buildExactTranslationSegments(translations) {
  return Object.fromEntries(
    LANGUAGES.map((language) => {
      const text = withDecimalComma(translations?.[language.code] || translations?.EN || '');
      return [language.code, text ? [{ text, red: false, tone: '', term: '' }] : []];
    })
  );
}

/**
 * Which ingredients the database already knows, and which have to go to the AI.
 *
 * Works on whole ingredient names. Asking about the loose words inside one
 * ingredient produced translations that were wrong per ingredient even when
 * every single word was right: "mango jam" is "mangojam" in Dutch, not "mango"
 * followed by "jam".
 */
export function analyzeIngredientsTerminology(sourceText, translationDb) {
  const knownTerms = [];
  const unmatchedTerms = [];

  for (const name of ingredientNames(sourceText)) {
    const hit = translationDb.lookupMany(termVariants(name));
    if (hit) {
      knownTerms.push({
        sourceTerm: name,
        databaseTerm: hit.english,
        translations: hit.translations,
        source: hit.source
      });
    } else {
      unmatchedTerms.push(name);
    }
  }

  return { exactTermHits: knownTerms, knownTerms, unmatchedTerms };
}

export async function translateIngredientsDeclaration({
  fieldName,
  sourceText,
  translationDb,
  openaiConfig,
  productContext
}) {
  const cleanSource = stripIngredientPrefix(sourceText);
  const exactHit = translationDb.lookup(cleanSource);
  if (exactHit) {
    return {
      fieldName,
      sourceText: cleanSource,
      status: 'database',
      trusted: true,
      translations: withDecimalCommaValues(exactHit.translations),
      languageSegments: buildExactTranslationSegments(exactHit.translations),
      reviewRequired: false,
      reviewReason: '',
      source: exactHit.source,
      notes: []
    };
  }

  const analysis = analyzeIngredientsTerminology(cleanSource, translationDb);
  const hasUnknownTerms = analysis.unmatchedTerms.length > 0;

  if (openaiConfig?.apiKey && openaiConfig.enableFallback !== false && hasUnknownTerms) {
    try {
      const fallback = await translateIngredientTermsWithOpenAi({
        fieldName,
        sourceText: cleanSource,
        config: openaiConfig,
        productContext,
        terminology: analysis.knownTerms,
        unmatchedTerms: analysis.unmatchedTerms
      });
      const translated = buildDatabaseTermTranslationResult(cleanSource, translationDb, fallback.termTranslations);
      const aiTerms = Object.values(fallback.termTranslations || {});
      const confidentAiTermCount = aiTerms.filter((term) => term?.confident).length;
      const uncertainAiTermCount = aiTerms.length - confidentAiTermCount;

      return {
        fieldName,
        sourceText: cleanSource,
        status: fallback.status,
        trusted: false,
        translations: translated.translations,
        languageSegments: translated.languageSegments,
        // Per unmatched term its own translations. These are what belongs in the
        // approved translations database — a whole declaration never recurs, its
        // individual terms do.
        termTranslations: fallback.termTranslations || null,
        reviewRequired: true,
        reviewReason: 'Ingredientendeclaratie bevat termen zonder exacte match in Labels_13_talen.xlsx; OpenAI/research fallback alleen voor onbekende termen gebruikt.',
        source: {
          type: fallback.status,
          terminologyHits: analysis.knownTerms.length,
          unmatchedTerms: analysis.unmatchedTerms,
          aiTermCount: aiTerms.length,
          confidentAiTermCount,
          uncertainAiTermCount,
          model: fallback.model || '',
          modelTier: fallback.modelTier || '',
          modelEscalated: Boolean(fallback.modelEscalated),
          modelReason: fallback.modelReason || '',
          sources: fallback.sources || []
        },
        notes: [
          `${analysis.knownTerms.length} bekende termen uit de vertalingendatabase groen/ongewijzigd gebruikt.`,
          `${confidentAiTermCount} onbekende term(en) via OpenAI fallback paars/high-confidence ingevuld.`,
          `${uncertainAiTermCount} onbekende term(en) via OpenAI fallback rood/onzeker ingevuld.`,
          ...analysis.unmatchedTerms.slice(0, 25).map((term) => `Geen exacte databasehit voor: ${term}`),
          ...(fallback.model ? [`OpenAI model: ${fallback.model}${fallback.modelEscalated ? ' (reviewmodel)' : ''}.`] : []),
          ...(fallback.modelReason ? [`Modelkeuze: ${fallback.modelReason}`] : []),
          ...(fallback.notes || [])
        ]
      };
    } catch (error) {
      const translated = buildDatabaseTermTranslationResult(cleanSource, translationDb);
      return {
        fieldName,
        sourceText: cleanSource,
        status: 'openai_fallback_error',
        trusted: false,
        translations: translated.translations,
        languageSegments: translated.languageSegments,
        termTranslations: null,
        reviewRequired: true,
        reviewReason: `Ingredientendeclaratie bevat onbekende termen en OpenAI/research faalde: ${error.message}`,
        source: {
          type: 'database_terms_after_openai_error',
          terminologyHits: analysis.knownTerms.length,
          unmatchedTerms: analysis.unmatchedTerms
        },
        notes: [
          `${analysis.knownTerms.length} bekende termen uit de vertalingendatabase gebruikt.`,
          ...analysis.unmatchedTerms.slice(0, 25).map((term) => `Geen exacte databasehit voor: ${term}`),
          error.message
        ]
      };
    }
  }

  const translated = buildDatabaseTermTranslationResult(cleanSource, translationDb);
  return {
    fieldName,
    sourceText: cleanSource,
    status: hasUnknownTerms ? 'database_terms_manual_required' : 'database_terms',
    trusted: !hasUnknownTerms,
    translations: hasUnknownTerms
      ? translated.translations
      : { ...translated.translations, EN: withDecimalComma(cleanSource) },
    languageSegments: hasUnknownTerms
      ? translated.languageSegments
      : {
          ...translated.languageSegments,
          EN: [{ text: withDecimalComma(cleanSource), red: false, tone: '', term: '' }]
        },
    reviewRequired: hasUnknownTerms,
    reviewReason: hasUnknownTerms
      ? 'Ingredientendeclaratie is gedeeltelijk uit Labels_13_talen.xlsx opgebouwd; onbekende samengestelde termen vereisen juridische QA.'
      : '',
    // No AI ran, so there are no proposals per term; the platform builds
    // placeholders from unmatchedTerms so QA can still fill them in.
    termTranslations: null,
    source: {
      type: 'database_terms',
      terminologyHits: analysis.knownTerms.length,
      unmatchedTerms: analysis.unmatchedTerms
    },
    notes: hasUnknownTerms
      ? [
          `${analysis.knownTerms.length} bekende termen uit de vertalingendatabase gebruikt.`,
          ...analysis.unmatchedTerms.slice(0, 25).map((term) => `Geen exacte databasehit voor: ${term}`),
          ...(openaiConfig?.apiKey ? [] : ['Geen OPENAI_API_KEY actief; onbekende termen zijn niet juridisch herzocht.'])
        ]
      : [`${analysis.knownTerms.length} termen uit de vertalingendatabase gebruikt.`]
  };
}
