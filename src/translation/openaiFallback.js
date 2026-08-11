import { LANGUAGES } from '../config.js';
import { LEGAL_REFS, LEGAL_TRANSLATION_INSTRUCTIONS } from './legalRefs.js';

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

export async function translateWithOpenAi({ fieldName, sourceText, config, productContext }) {
  if (!sourceText) {
    return {
      translations: allLanguages(''),
      notes: ['Lege brontekst.'],
      status: 'empty'
    };
  }

  if (!config.apiKey) {
    return {
      translations: allLanguages(sourceText),
      notes: ['Geen OPENAI_API_KEY ingesteld; Engelse brontekst is tijdelijk overgenomen en moet handmatig worden vertaald/gecontroleerd.'],
      status: 'manual_required'
    };
  }

  const legalSourceList = LEGAL_REFS.map((ref) => `- ${ref.title}: ${ref.url}`).join('\n');
  const input = `
${LEGAL_TRANSLATION_INSTRUCTIONS}

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

  const payload = {
    model: config.model,
    input
  };

  if (config.enableWebSearch) {
    payload.tools = [{ type: 'web_search_preview', search_context_size: 'medium' }];
    payload.max_tool_calls = 4;
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const responseJson = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`OpenAI fallback mislukt (${response.status}): ${responseJson.error?.message || response.statusText}`);
  }

  const parsed = parseJsonResponse(extractOutputText(responseJson));
  const translations = allLanguages('');
  for (const language of LANGUAGES) {
    translations[language.code] = String(parsed.translations?.[language.code] || parsed.translations?.[language.code.toLowerCase()] || '').trim();
    if (!translations[language.code]) translations[language.code] = language.code === 'EN' ? sourceText : sourceText;
  }

  return {
    translations,
    notes: Array.isArray(parsed.notes) ? parsed.notes.map(String) : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources.map(String) : [],
    status: 'openai_researched'
  };
}
