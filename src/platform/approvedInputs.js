// Turns the QA-approved label model back into the shapes the Word template reads.

/**
 * The definitive label must be made from the values QA approved, not from the
 * values the agent originally produced. The template reads a parsed
 * specification plus a translations object, so the approved model has to be laid
 * back over both. This is the inverse of buildSpecFields / buildTranslationFields
 * in labelModel.js — that mapping goes spec -> fields, this one goes fields ->
 * spec.
 *
 * Deliberately pure and synchronous: given a spec and a model it does one thing,
 * so a test can prove that an edit made in the platform ends up in the document.
 */
import { ISO_TO_AGENT } from '../utils/languages.js';
import { TRANSLATION_JOB_KEYS } from './labelModel.js';

/** Field key on the platform label -> where that value lives in the spec. */
const SPEC_PATHS = {
  article_number: ['articleNumber'],
  product_name: ['description'],
  legal_name: ['legalProduct'],
  brand: ['brand'],
  supplier: ['supplierNumber'],
  origin: ['countryOfProduction'],
  net_weight: ['logistics', 'netWeight'],
  ean: ['logistics', 'ean'],
  ingredients: ['ingredientsDeclaration'],
  preparation: ['storage', 'directionForUse'],
  warnings: ['storage', 'warning'],
  catch_area: ['fish', 'fishingArea'],
  fishing_gear: ['fish', 'fishingMethod'],
  scientific_name: ['fish', 'scientificName'],
  production_method: ['fish', 'productionMethod']
};

const NUTRITION_PREFIX = 'nutrition.';

function setPath(target, pathSegments, value) {
  let cursor = target;
  for (const segment of pathSegments.slice(0, -1)) {
    if (!cursor[segment] || typeof cursor[segment] !== 'object') cursor[segment] = {};
    cursor = cursor[segment];
  }
  cursor[pathSegments.at(-1)] = value;
}

function isFilled(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

export function buildApprovedInputs({ spec, labelModel }) {
  const fields = Array.isArray(labelModel?.fields) ? labelModel.fields : [];
  const translations = {};
  const applied = { spec: 0, nutrition: 0, translations: 0, ignored: 0 };

  for (const labelField of fields) {
    const value = labelField?.value;

    // An empty value is not an instruction to erase the spec: a language QA left
    // blank keeps whatever the specification said.
    if (!isFilled(value)) {
      applied.ignored += 1;
      continue;
    }

    const text = String(value);

    if (labelField.languageCode) {
      // Term fields carry their own group (term:*) and are not a label field of
      // their own; their edits already went into the declaration line.
      if (!TRANSLATION_JOB_KEYS.has(labelField.groupKey)) {
        applied.ignored += 1;
        continue;
      }

      const agentCode = ISO_TO_AGENT[labelField.languageCode];
      if (!agentCode) {
        applied.ignored += 1;
        continue;
      }

      if (!translations[labelField.groupKey]) {
        translations[labelField.groupKey] = {
          fieldName: labelField.groupKey,
          translations: {},
          // Approved by QA, so nothing on the definitive label is marked for
          // review. This is also why no languageSegments are passed on: the
          // colour coding is a review aid, not part of the finished label.
          reviewRequired: false,
          trusted: true,
          status: 'qa_approved'
        };
      }

      translations[labelField.groupKey].translations[agentCode] = text;
      applied.translations += 1;
      continue;
    }

    if (labelField.key?.startsWith(NUTRITION_PREFIX)) {
      const key = labelField.key.slice(NUTRITION_PREFIX.length);
      if (!spec.nutrition || typeof spec.nutrition !== 'object') spec.nutrition = {};
      spec.nutrition[key] = text;
      applied.nutrition += 1;
      continue;
    }

    const specPath = SPEC_PATHS[labelField.key];
    if (!specPath) {
      applied.ignored += 1;
      continue;
    }

    setPath(spec, specPath, text);
    applied.spec += 1;
  }

  // The template falls back to sourceText when a language is missing, so give it
  // the approved English line rather than the agent's original.
  for (const entry of Object.values(translations)) {
    entry.sourceText = entry.translations.EN ?? '';
  }

  return { spec, translations, applied };
}

export { SPEC_PATHS };
