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

function confidenceDetails(raw = {}) {
  const confidence = String(raw.confidence || raw.certainty || raw.confidenceLevel || '').trim().toLowerCase();
  const confidenceScore = Number(raw.confidenceScore ?? raw.score ?? raw.confidence_score ?? NaN);
  const confidenceReason = String(raw.confidenceReason || raw.reason || raw.confidence_note || '').trim();
  const threshold = Number(raw.threshold ?? raw.confidenceThreshold ?? 0.8);
  const explicitlyUncertain = ['medium', 'low'].includes(confidence);
  const confident = !explicitlyUncertain && (confidence === 'high' || (Number.isFinite(confidenceScore) && confidenceScore >= threshold));

  return {
    confidence: confidence || (confident ? 'high' : 'unknown'),
    confidenceScore: Number.isFinite(confidenceScore) ? confidenceScore : null,
    confidenceReason,
    confident
  };
}

/** Worth trying again: a network hiccup, a rate limit or a server error. */
function isRetryable(error) {
  if (!error) return false;
  // Set explicitly where the status alone would mislead: a body that dies
  // halfway carries HTTP 200 while being a transport failure.
  if (error.retryable !== undefined) return Boolean(error.retryable);
  if (error.status && error.status !== 429 && error.status < 500) return false;
  return true;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calls OpenAI, and tries again when the attempt failed for a reason that can
 * pass.
 *
 * One failure here used to cost the whole declaration: the agent fell back to
 * "database terms only", so every unknown ingredient stayed English and red
 * while OpenAI had actually answered. Nothing said so on the label, which made
 * it look like a bug in the platform.
 */
async function requestOpenAiJsonWithRetry({ config, model, input }) {
  const attempts = Math.max(1, Number(config.maxAttempts || 3));
  const delay = Math.max(0, Number(config.retryDelayMs ?? 4000));
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestOpenAiJson({ config, model, input });
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryable(error)) break;

      // Linear backoff: the failures worth retrying here are timeouts and
      // dropped sockets, where waiting longer helps more than waiting smarter.
      const pause = delay * attempt;
      console.warn(
        `OpenAI poging ${attempt}/${attempts} mislukt (${error.message}); opnieuw over ${pause} ms.`
      );
      await wait(pause);
    }
  }

  throw lastError;
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

  // Not swallowed: an empty object here reads as "OpenAI returned nothing
  // useful", while the real cause is a body that died halfway. That is
  // retryable, and only visible if it is allowed to surface.
  let responseJson;
  try {
    responseJson = await response.json();
  } catch (error) {
    const broken = new Error(
      `OpenAI-antwoord kon niet gelezen worden (HTTP ${response.status}): ${error.message}`
    );
    // The status says 200 because the headers arrived; the body did not. That is
    // a dropped connection, so it is worth another attempt.
    broken.retryable = true;
    throw broken;
  }

  if (!response.ok) {
    const failure = new Error(
      `OpenAI fallback mislukt (${response.status}): ${responseJson.error?.message || response.statusText}`
    );
    failure.status = response.status;
    throw failure;
  }

  return parseJsonResponse(extractOutputText(responseJson));
}

function escalationReason({ fieldKind = '', unmatchedTerms = [] }) {
  if (fieldKind === 'ingredients' && unmatchedTerms.length > 0) {
    return `Ingredientendeclaratie bevat ${unmatchedTerms.length} onbekende term(en).`;
  }
  return '';
}

export function selectOpenAiModel({ config, fieldKind = '', unmatchedTerms = [] }) {
  const standardModel = config?.model || 'gpt-5-mini';
  const reviewModel = config?.reviewModel || '';
  const reason = escalationReason({ fieldKind, unmatchedTerms });
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
  "confidence": "high|medium|low",
  "confidenceScore": 0.0,
  "confidenceReason": "why this is or is not a high-confidence legal label translation",
  "sources": ["url"]
}`;

  const parsed = await requestOpenAiJsonWithRetry({
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
    ...confidenceDetails({
      ...parsed,
      threshold: config.confidencePurpleThreshold
    }),
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
        item
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
    termTranslations[term] = {
      translations,
      ...confidenceDetails({
        ...raw,
        threshold: parsed.confidencePurpleThreshold
      })
    };
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
- Use confidence="high" only when the proposed legal label term is a common/standard formulation and you do not need extra supplier/QA information.
- Use confidence="medium" or "low" when wording depends on context, national convention, product facts, composition details or source interpretation.

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
    },
    "confidence": "high|medium|low",
    "confidenceScore": 0.0,
    "confidenceReason": "why this term is or is not high-confidence"
  },
  "notes": ["short QA note"],
  "sources": ["url"]
}`;

  const parsed = await requestOpenAiJsonWithRetry({
    config,
    model: selectedModel.model,
    input
  });

  return {
    termTranslations: normalizeTermTranslations({
      ...parsed,
      confidencePurpleThreshold: config.confidencePurpleThreshold
    }, terms),
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources.map(String) : [],
    model: selectedModel.model,
    modelTier: selectedModel.tier,
    modelEscalated: selectedModel.escalated,
    modelReason: selectedModel.reason,
    status: 'openai_terms_researched'
  };
}
