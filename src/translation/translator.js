import { LANGUAGES } from '../config.js';
import { translateWithOpenAi } from './openaiFallback.js';

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

export async function translateField({ fieldName, sourceText, translationDb, openaiConfig, productContext, candidates = [] }) {
  const candidateTexts = [sourceText, ...candidates].filter(Boolean);
  const dbHit = translationDb.lookupMany(candidateTexts);
  if (dbHit) {
    return {
      fieldName,
      sourceText,
      status: 'database',
      trusted: true,
      translations: applySourcePlaceholders(dbHit.translations, sourceText),
      reviewRequired: false,
      reviewReason: '',
      source: dbHit.source,
      notes: []
    };
  }

  try {
    const fallback = await translateWithOpenAi({
      fieldName,
      sourceText,
      config: openaiConfig,
      productContext
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
        sources: fallback.sources || []
      },
      notes: [
        ...(fallback.model ? [`OpenAI model: ${fallback.model}${fallback.modelEscalated ? ' (reviewmodel)' : ''}.`] : []),
        ...(fallback.modelReason ? [`Modelkeuze: ${fallback.modelReason}`] : []),
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
