// Handles OpenAI fallback translation/research for texts that are not trusted database hits.
import { LANGUAGES } from '../config.js';
import { LEGAL_REFS, LEGAL_TRANSLATION_INSTRUCTIONS } from './legalRefs.js';
import { compactKey } from '../utils/normalize.js';

function allLanguages(text) {
  return Object.fromEntries(LANGUAGES.map((language) => [language.code, text || '']));
}

function extractOutputText(responseJson) {
  if (typeof responseJson.output_text === 'string') return responseJson.output_text;
  const chunks = [];
  for (const item of responseJson.output || []) {
    for (const content of item.content || []) {
      if (content.type === 'output_text' && content.text) chunks.push(content.text);
      if (content.type === 'text' && content.text) chunks.push(content.text);
    }
  }
  return chunks.join('\n').trim();
}

function parseJsonResponse(text) {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('OpenAI response bevatte geen JSON-object.');
    return JSON.parse(match[0]);
  }
}

function formatTerminology(terminology = []) {
  if (!terminology.length) return 'No terminology hits.';
  return terminology
    .slice(0, 80)
    .map((item) => {
      const translations = LANGUAGES
        .map((language) => `${language.code}=${item.translations?.[language.code] || ''}`)
        .join(' | ');
      return `- Source term "${item.sourceTerm}" must follow database term "${item.databaseTerm}": ${translations}`;
    })
    .join('\n');
}

async function requestOpenAiJson({ config, model, input }) {
  const payload = {
    model,
    input
  };

  if (config.enableWebSearch) {
    payload.tools = [{ type: 'web_search_preview', search_context_size: 'medium' }];
    payload.max_tool_calls = 4;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(config.timeoutMs || 60_000));
  let response;
  try {
    response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`OpenAI fallback timeout na ${config.timeoutMs || 60_000} ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  const responseJson = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI fallback mislukt (${response.status}): ${responseJson.error?.message || response.statusText}`);
  }

  return parseJsonResponse(extractOutputText(responseJson));
}

function escalationReason({ fieldName, fieldKind = '', unmatchedTerms = [] }) {
  const normalizedField = String(fieldName || '').toLowerCase();
  if (fieldKind === 'ingredients' && unmatchedTerms.length > 0) {
    return `Ingredientendeclaratie bevat ${unmatchedTerms.length} onbekende term(en).`;
  }
  if (/productnaam|wettelijke|legal product/.test(normalizedField)) {
    return 'Productnaam/wettelijke benaming zonder databasehit.';
  }
  if (/waarschuwing|warning/.test(normalizedField)) {
    return 'Waarschuwing zonder databasehit.';
  }
  if (/visserij|vangst|fishing|fishery|productiemethode/.test(normalizedField)) {
    return 'Visserijveld zonder databasehit.';
  }
  return '';
}

export function selectOpenAiModel({ config, fieldName, fieldKind = '', unmatchedTerms = [] }) {
  const standardModel = config?.model || 'gpt-5-mini';
  const reviewModel = config?.reviewModel || '';
  const reason = escalationReason({ fieldName, fieldKind, unmatchedTerms });
  const canEscalate = config?.enableModelEscalation !== false && reviewModel && reviewModel !== standardModel;

  if (reason && canEscalate) {
    return {
      model: reviewModel,
      tier: 'review',
      escalated: true,
      reason
    };
  }

  return {
    model: standardModel,
    tier: 'standard',
    escalated: false,
    reason: reason
      ? `${reason} ${reviewModel ? 'Model-escalatie staat uit; standaardmodel gebruikt.' : 'Geen OPENAI_REVIEW_MODEL ingesteld; standaardmodel gebruikt.'}`
      : ''
  };
}

export async function translateWithOpenAi({
  fieldName,
  sourceText,
  config,
  productContext,
  fieldKind = '',
  terminology = [],
  unmatchedTerms = []
}) {
  if (!sourceText) {
    return {
      translations: allLanguages(''),
      notes: ['Lege brontekst.'],
      status: 'empty'
    };
  }

  if (!config.enableFallback || !config.apiKey) {
    return {
      translations: allLanguages(sourceText),
      notes: [config.enableFallback ? 'Geen OPENAI_API_KEY ingesteld; Engelse brontekst is tijdelijk overgenomen en moet handmatig worden vertaald/gecontroleerd.' : 'OpenAI fallback staat uit; brontekst is tijdelijk overgenomen en moet handmatig worden vertaald/gecontroleerd.'],
      status: 'manual_required'
    };
  }

  const selectedModel = selectOpenAiModel({
    config,
    fieldName,
    fieldKind,
    unmatchedTerms
  });

  const legalSourceList = LEGAL_REFS.map((ref) => `- ${ref.title}: ${ref.url}`).join('\n');
  const ingredientInstructions = fieldKind === 'ingredients'
    ? `
Ingredient declaration rules:
- Preserve ingredient order, percentages, E-numbers, compound-ingredient brackets and additive function classes.
- Use the approved terminology database below wherever applicable.
- For unmatched terms, find legally conservative food-label names rather than literal casual translations.
- Keep allergen names emphasised in CAPITALS when present in the source or terminology.
- Do not add, remove, reorder or merge ingredients.

Approved terminology from Labels_13_talen.xlsx:
${formatTerminology(terminology)}

Terms without exact database match, requiring legal research:
${unmatchedTerms.length ? unmatchedTerms.map((term) => `- ${term}`).join('\n') : '- none'}
`
    : '';
  const input = `
${LEGAL_TRANSLATION_INSTRUCTIONS}
${ingredientInstructions}

Legal reference sources to use/check where relevant:
${legalSourceList}

Product context:
${JSON.stringify(productContext, null, 2)}

Field: ${fieldName}
Source text:
${sourceText}

Return only JSON:
{
  "translations": {
    "DE": "...",
    "NL": "...",
    "FR": "...",
    "SE": "...",
    "FI": "...",
    "DK": "...",
    "IT": "...",
    "EN": "...",
    "CZ": "...",
    "HU": "...",
    "PL": "...",
    "ES": "...",
    "SK": "..."
  },
  "notes": ["short QA note"],
  "sources": ["url"]
}`;

  const parsed = await requestOpenAiJson({
    config,
    model: selectedModel.model,
    input
  });
  const translations = allLanguages('');
  for (const language of LANGUAGES) {
    translations[language.code] = String(parsed.translations?.[language.code] || parsed.translations?.[language.code.toLowerCase()] || '').trim();
    if (!translations[language.code]) translations[language.code] = language.code === 'EN' ? sourceText : sourceText;
  }

  return {
    translations,
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources.map(String) : [],
    model: selectedModel.model,
    modelTier: selectedModel.tier,
    modelEscalated: selectedModel.escalated,
    modelReason: selectedModel.reason,
    status: 'openai_researched'
  };
}

function normalizeTermTranslations(parsed, unmatchedTerms) {
  const rawContainer = parsed.termTranslations || parsed.terms || parsed.translationsByTerm || {};
  const entries = Array.isArray(rawContainer)
    ? rawContainer.map((item) => [
        item.sourceTerm || item.term || item.source || '',
        item.translations || item
      ])
    : Object.entries(rawContainer);
  const byCompact = new Map(
    entries
      .filter(([term]) => term)
      .map(([term, translations]) => [compactKey(term), translations])
  );

  const termTranslations = {};
  for (const term of unmatchedTerms) {
    const raw = rawContainer[term] || byCompact.get(compactKey(term)) || {};
    const translations = allLanguages(term);
    for (const language of LANGUAGES) {
      translations[language.code] = String(
        raw?.[language.code] ||
        raw?.[language.code.toLowerCase()] ||
        raw?.translations?.[language.code] ||
        raw?.translations?.[language.code.toLowerCase()] ||
        ''
      ).trim() || term;
    }
    termTranslations[term] = translations;
  }

  return termTranslations;
}

export async function translateIngredientTermsWithOpenAi({
  fieldName,
  sourceText,
  config,
  productContext,
  terminology = [],
  unmatchedTerms = []
}) {
  const terms = unmatchedTerms.map((term) => String(term || '').trim()).filter(Boolean);
  if (!terms.length) {
    return {
      termTranslations: {},
      notes: ['Geen onbekende ingredienttermen.'],
      status: 'empty'
    };
  }

  if (!config.enableFallback || !config.apiKey) {
    return {
      termTranslations: Object.fromEntries(terms.map((term) => [term, allLanguages(term)])),
      notes: [config.enableFallback ? 'Geen OPENAI_API_KEY ingesteld; onbekende ingredienttermen blijven origineel en moeten handmatig worden gecontroleerd.' : 'OpenAI fallback staat uit; onbekende ingredienttermen blijven origineel en moeten handmatig worden gecontroleerd.'],
      status: 'manual_required'
    };
  }

  const selectedModel = selectOpenAiModel({
    config,
    fieldName,
    fieldKind: 'ingredients',
    unmatchedTerms: terms
  });
  const legalSourceList = LEGAL_REFS.map((ref) => `- ${ref.title}: ${ref.url}`).join('\n');
  const input = `
${LEGAL_TRANSLATION_INSTRUCTIONS}

Task:
Translate ONLY the ingredient terms listed under "Terms requiring research".
The full ingredient declaration is provided only as context.

Strict rules:
- Do not translate the full ingredient declaration.
- Do not alter, replace, improve or re-translate protected database terminology.
- Protected database terminology is already approved and will be inserted separately by code.
- Return legally conservative food-label terms, not casual literal translations.
- Preserve allergen emphasis in CAPITALS where relevant.
- Do not add missing product facts.
- If a term remains uncertain, provide the best conservative term and explain the uncertainty in notes.

Protected database terminology from Labels_13_talen.xlsx. The code will keep these terms green and untouched:
${formatTerminology(terminology)}

Terms requiring research. Translate these terms only:
${terms.map((term) => `- ${term}`).join('\n')}

Full ingredient declaration for context only:
${sourceText}

Legal reference sources to use/check where relevant:
${legalSourceList}

Product context:
${JSON.stringify(productContext, null, 2)}

Return only JSON:
{
  "termTranslations": {
    "exact source term 1": {
      "DE": "...",
      "NL": "...",
      "FR": "...",
      "SE": "...",
      "FI": "...",
      "DK": "...",
      "IT": "...",
      "EN": "...",
      "CZ": "...",
      "HU": "...",
      "PL": "...",
      "ES": "...",
      "SK": "..."
    }
  },
  "notes": ["short QA note"],
  "sources": ["url"]
}`;

  const parsed = await requestOpenAiJson({
    config,
    model: selectedModel.model,
    input
  });

  return {
    termTranslations: normalizeTermTranslations(parsed, terms),
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources.map(String) : [],
    model: selectedModel.model,
    modelTier: selectedModel.tier,
    modelEscalated: selectedModel.escalated,
    modelReason: selectedModel.reason,
    status: 'openai_terms_researched'
  };
}
