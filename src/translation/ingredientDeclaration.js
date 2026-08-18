// Builds ingredient declarations from trusted database terminology and marks unknown parts for review.
import { LANGUAGES } from '../config.js';
import { compactKey } from '../utils/normalize.js';
import { translateIngredientTermsWithOpenAi } from './openaiFallback.js';

const INGREDIENT_PREFIX = /^ingredients:\s*/i;
const TERM_SPLIT_REGEX = /[,;.:[\](){}]+|\r?\n+/g;
const WORD_BOUNDARY_LEFT = '(?<![\\p{L}\\p{N}])';
const WORD_BOUNDARY_RIGHT = '(?![\\p{L}\\p{N}])';
const AI_CONFIDENT_PURPLE = '7030A0';

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function replacementVariants(english) {
  const variants = termVariants(english);
  if (/\bSOYA\b/i.test(english)) variants.push(english.replace(/\bSOYA\b/gi, 'SOY'));
  if (/\bcolour/i.test(english)) variants.push(english.replace(/\bcolour/gi, 'color'));
  if (/\bflavour/i.test(english)) variants.push(english.replace(/\bflavour/gi, 'flavor'));
  if (/\bstabiliser/i.test(english)) variants.push(english.replace(/\bstabiliser/gi, 'stabilizer'));
  if (/\bhydrolysed/i.test(english)) variants.push(english.replace(/\bhydrolysed/gi, 'hydrolyzed'));
  return unique(variants).filter((variant) => compactKey(variant).length >= 3);
}

function cleanCandidateTerm(chunk) {
  return String(chunk || '')
    .replace(/\bE\s*\d+[a-z]?\b/gi, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\s*%/g, ' ')
    .replace(/\b\d+(?:[.,]\d+)?\b/g, ' ')
    .replace(/\b(?:ingredients|ingredient|sachet|and|or)\b/gi, ' ')
    .replace(/^[.\-:\s]+|[.\-:\s]+$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateTermsFromDeclaration(text) {
  return unique(
    stripIngredientPrefix(text)
      .split(TERM_SPLIT_REGEX)
      .map(cleanCandidateTerm)
      .filter((term) => /[a-z]/i.test(term))
      .filter((term) => compactKey(term).length >= 3)
  );
}

function patternForTerm(term) {
  return new RegExp(`${WORD_BOUNDARY_LEFT}${escapeRegExp(term)}${WORD_BOUNDARY_RIGHT}`, 'giu');
}

function termAppears(text, term) {
  return patternForTerm(term).test(text);
}

function findKnownTerms(sourceText, translationDb) {
  const hits = [];
  const seen = new Set();

  for (const entry of translationDb.entryList()) {
    for (const variant of replacementVariants(entry.english)) {
      if (!termAppears(sourceText, variant)) continue;
      if (seen.has(entry.key)) break;
      seen.add(entry.key);
      hits.push({
        sourceTerm: variant,
        databaseTerm: entry.english,
        translations: entry.translations,
        source: entry.source
      });
      break;
    }
    if (hits.length >= 80) break;
  }

  return hits;
}

function mergeSegments(segments) {
  const merged = [];
  for (const segment of segments) {
    if (!segment?.text) continue;
    const red = Boolean(segment.red);
    const color = segment.color || '';
    const previous = merged.at(-1);
    if (previous && previous.red === red && (previous.color || '') === color) {
      previous.text += segment.text;
    } else {
      merged.push({ text: segment.text, red, color });
    }
  }
  return merged;
}

function isReviewText(text) {
  const withoutFixedCodes = String(text || '').replace(/\bE\s*\d+[a-z]?\b/gi, ' ');
  return /\p{L}/u.test(withoutFixedCodes);
}

function knownSourceSpans(sourceText, translationDb) {
  const spans = [];
  for (const entry of translationDb.entryList()) {
    for (const variant of replacementVariants(entry.english).sort((a, b) => b.length - a.length)) {
      const pattern = patternForTerm(variant);
      for (const match of sourceText.matchAll(pattern)) {
        spans.push({
          start: match.index,
          end: match.index + match[0].length,
          sourceTerm: match[0],
          entry
        });
      }
    }
  }

  spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));

  const selected = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start < cursor) continue;
    selected.push(span);
    cursor = span.end;
  }
  return selected;
}

function unknownTermsFromDatabaseGaps(sourceText, translationDb) {
  const terms = [];
  const spans = knownSourceSpans(sourceText, translationDb);
  let cursor = 0;

  for (const span of spans) {
    if (span.start > cursor) {
      terms.push(...candidateTermsFromDeclaration(sourceText.slice(cursor, span.start)));
    }
    cursor = Math.max(cursor, span.end);
  }

  if (cursor < sourceText.length) {
    terms.push(...candidateTermsFromDeclaration(sourceText.slice(cursor)));
  }

  return unique(terms);
}

function pushGapSegment(segments, text) {
  if (!text) return;
  segments.push({
    text,
    red: isReviewText(text)
  });
}

function spanTextForLanguage(span, languageCode) {
  if (span.entry) {
    return span.entry.translations?.[languageCode] || span.entry.translations?.EN || span.entry.english || span.sourceTerm;
  }
  return span.aiTerm?.translations?.[languageCode] || span.aiTerm?.translations?.EN || span.translations?.[languageCode] || span.translations?.EN || span.sourceTerm;
}

function sourceSegmentsForLanguage(sourceText, spans, languageCode) {
  const segments = [];
  let cursor = 0;

  for (const span of spans) {
    pushGapSegment(segments, sourceText.slice(cursor, span.start));
    const replacement = spanTextForLanguage(span, languageCode);
    segments.push({
      text: String(replacement || span.sourceTerm).trim(),
      red: Boolean(span.red),
      color: span.color || ''
    });
    cursor = span.end;
  }

  pushGapSegment(segments, sourceText.slice(cursor));
  return mergeSegments(segments);
}

function segmentsToText(segments) {
  return segments.map((segment) => segment.text).join('').replace(/\s+([,;:)])/g, '$1').replace(/([(])\s+/g, '$1').replace(/\s{2,}/g, ' ').trim();
}

function overlapsAny(span, others) {
  return others.some((other) => span.start < other.end && span.end > other.start);
}

function aiSourceSpans(sourceText, termTranslations = {}, protectedSpans = []) {
  const spans = [];
  const terms = Object.keys(termTranslations || {}).sort((a, b) => b.length - a.length);
  const seen = new Set();

  for (const term of terms) {
    const aiTerm = termTranslations[term];
    for (const variant of termVariants(term).sort((a, b) => b.length - a.length)) {
      const pattern = patternForTerm(variant);
      for (const match of sourceText.matchAll(pattern)) {
        const span = {
          start: match.index,
          end: match.index + match[0].length,
          sourceTerm: match[0],
          aiTerm,
          red: !aiTerm?.confident,
          color: aiTerm?.confident ? AI_CONFIDENT_PURPLE : ''
        };
        const key = `${span.start}:${span.end}`;
        if (seen.has(key) || overlapsAny(span, protectedSpans)) continue;
        seen.add(key);
        spans.push(span);
      }
    }
  }

  return spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
}

function selectSpans(spans) {
  const selected = [];
  let cursor = 0;

  for (const span of spans.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))) {
    if (span.start < cursor) continue;
    selected.push(span);
    cursor = span.end;
  }
  return selected;
}

function buildDatabaseTermTranslationResult(sourceText, translationDb, termTranslations = {}) {
  const databaseSpans = knownSourceSpans(sourceText, translationDb);
  const aiSpans = aiSourceSpans(sourceText, termTranslations, databaseSpans);
  const spans = selectSpans([...databaseSpans, ...aiSpans]);
  const translations = {};
  const languageSegments = {};

  for (const language of LANGUAGES) {
    const segments = sourceSegmentsForLanguage(sourceText, spans, language.code);
    translations[language.code] = segmentsToText(segments);
    languageSegments[language.code] = segments;
  }

  return { translations, languageSegments };
}

function buildExactTranslationSegments(translations) {
  return Object.fromEntries(
    LANGUAGES.map((language) => {
      const text = translations?.[language.code] || translations?.EN || '';
      return [language.code, text ? [{ text, red: false }] : []];
    })
  );
}

export function analyzeIngredientsTerminology(sourceText, translationDb) {
  const candidates = candidateTermsFromDeclaration(sourceText);
  const gapTerms = unknownTermsFromDatabaseGaps(sourceText, translationDb);
  const unmatchedTerms = [];
  const exactTermHits = [];

  for (const term of candidates) {
    const hit = translationDb.lookupMany(termVariants(term));
    if (hit) {
      exactTermHits.push({
        sourceTerm: term,
        databaseTerm: hit.english,
        translations: hit.translations,
        source: hit.source
      });
    } else {
      unmatchedTerms.push(term);
    }
  }

  return {
    exactTermHits,
    knownTerms: findKnownTerms(sourceText, translationDb),
    unmatchedTerms: gapTerms.length ? gapTerms : unique(unmatchedTerms)
  };
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
      translations: exactHit.translations,
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
    translations: hasUnknownTerms ? translated.translations : { ...translated.translations, EN: cleanSource },
    languageSegments: hasUnknownTerms
      ? translated.languageSegments
      : { ...translated.languageSegments, EN: [{ text: cleanSource, red: false }] },
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
