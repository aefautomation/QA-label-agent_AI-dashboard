// Translates one label field: first via the translation database, then via OpenAI fallback when needed.
import { LANGUAGES } from '../config.js';
import { translateWithOpenAi } from './openaiFallback.js';
import { translationOptionLanguages } from './translationOptions.js';

function allLanguages(text) {
  return Object.fromEntries(LANGUAGES.map((language) => [language.code, text || '']));
}

function extractENumbers(text) {
  return Array.from(String(text || '').matchAll(/\bE\s*\d+[a-z]?\b/gi), (match) =>
    match[0].replace(/\s+/g, '').toUpperCase()
  );
}

function applySourcePlaceholders(translations, sourceText) {
  const eNumbers = extractENumbers(sourceText);
  if (!eNumbers.length) return translations;

  const hydrated = {};
  for (const [languageCode, text] of Object.entries(translations || {})) {
    let index = 0;
    hydrated[languageCode] = String(text || '')
      .replace(/E(?:\u2026|\.\.\.)/g, () => eNumbers[index++] || eNumbers.at(-1))
      .replace(/\b(E\d+[a-z]?)(may)\b/gi, '$1 may');
  }
  return hydrated;
}

export async function translateField({
  fieldName,
  sourceText,
  translationDb,
  openaiConfig,
  productContext,
  candidates = [],
  /**
   * Which kind of label field this is, so the prompt can carry the rules for it.
   * Translating a warning, a sales name and a catch area by the same generic
   * instruction is what produced wording nobody would put on a label.
   */
  fieldKind = ''
}) {
  const candidateTexts = [sourceText, ...candidates].filter(Boolean);
  const dbHit = translationDb.lookupMany(candidateTexts);
  if (dbHit) {
    const translations = applySourcePlaceholders(dbHit.translations, sourceText);
    // A stored value that offers alternatives is not an answer. Without this the
    // field came back trusted and green, and QA was never asked to pick one.
    const optionLanguages = translationOptionLanguages(translations);
    const hasOptions = optionLanguages.length > 0;

    return {
      fieldName,
      sourceText,
      status: hasOptions ? 'database_options' : 'database',
      trusted: !hasOptions,
      translations,
      reviewRequired: hasOptions,
      reviewReason: hasOptions
        ? 'Vertalingendatabase bevat meerdere opties; QA moet de juiste optie kiezen.'
        : '',
      source: dbHit.source,
      notes: hasOptions
        ? [`Opties gevonden in taal/talen: ${optionLanguages.join(', ')}.`]
        : []
    };
  }

  try {
    const fallback = await translateWithOpenAi({
      fieldName,
      sourceText,
      config: openaiConfig,
      productContext,
      fieldKind
    });

    return {
      fieldName,
      sourceText,
      status: fallback.status,
      trusted: false,
      translations: fallback.translations,
      reviewRequired: true,
      reviewReason: 'Geen exacte match in Labels_13_talen.xlsx; fallback/research gebruikt.',
      source: {
        type: fallback.status,
        model: fallback.model || '',
        modelTier: fallback.modelTier || '',
        modelEscalated: Boolean(fallback.modelEscalated),
        modelReason: fallback.modelReason || '',
        confident: Boolean(fallback.confident),
        confidence: fallback.confidence || '',
        confidenceScore: fallback.confidenceScore,
        confidenceReason: fallback.confidenceReason || '',
        sources: fallback.sources || []
      },
      notes: [
        ...(fallback.model ? [`OpenAI model: ${fallback.model}${fallback.modelEscalated ? ' (reviewmodel)' : ''}.`] : []),
        ...(fallback.modelReason ? [`Modelkeuze: ${fallback.modelReason}`] : []),
        ...(fallback.confidence ? [`AI zekerheid: ${fallback.confidence}${fallback.confidenceScore == null ? '' : ` (${fallback.confidenceScore})`}.`] : []),
        ...(fallback.confidenceReason ? [`Zekerheidsreden: ${fallback.confidenceReason}`] : []),
        ...(fallback.notes || [])
      ]
    };
  } catch (error) {
    return {
      fieldName,
      sourceText,
      status: 'fallback_error',
      trusted: false,
      translations: allLanguages(sourceText),
      reviewRequired: true,
      reviewReason: `Geen databasehit en fallback faalde: ${error.message}`,
      source: { type: 'source_text_copy' },
      notes: [error.message]
    };
  }
}
