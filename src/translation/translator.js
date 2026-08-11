import { LANGUAGES } from '../config.js';
import { translateWithOpenAi } from './openaiFallback.js';

function allLanguages(text) {
  return Object.fromEntries(LANGUAGES.map((language) => [language.code, text || '']));
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
      translations: dbHit.translations,
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
        sources: fallback.sources || []
      },
      notes: fallback.notes || []
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
