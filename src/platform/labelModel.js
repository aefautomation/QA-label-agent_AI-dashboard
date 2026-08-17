// Builds the AEF AI Platform label model from one label run.
//
// This is the canonical shape the platform reviews and stores; it replaces the
// guesswork the platform used to do on the agent's loose JSON. Field keys match
// what the platform expects (lib/label-agent/types.ts), so QA edits map straight
// back onto the right field.
//
// Colour coding, mapped from this agent's own statuses:
//   database                  -> green  / database        (approved translation DB)
//   openai_researched         -> purple / ai_high         when source.confident
//   openai_terms_researched   -> purple / ai_high         when source.confident
//   ...same, not confident    -> red    / ai_uncertain
//   manual_required           -> red    / ai_uncertain    (no key / fallback off)
//   fallback_error            -> red    / ai_uncertain
//   empty / not_applicable    -> skipped, nothing to review
import { AGENT_TO_ISO, isoLanguageLabel } from '../utils/languages.js';
import { isMeaningful, normalizeText } from '../utils/normalize.js';

const GREEN_STATUSES = new Set(['database']);
const RESEARCH_STATUSES = new Set(['openai_researched', 'openai_terms_researched']);
const SKIP_STATUSES = new Set(['empty', 'not_applicable']);
// The ingredient declaration was assembled from database terms, but it contained
// terms without an exact hit. Most of the text is trusted; the uncertain parts
// are listed separately as per-term review points.
const PARTIAL_DATABASE_STATUSES = new Set(['database_terms_manual_required']);

/** Which label section and translation category each translation job belongs to. */
const JOB_META = {
  productName: { section: 'identification', category: 'legal_product', fieldKey: 'legal_name' },
  ingredients: { section: 'composition', category: 'ingredient', fieldKey: 'ingredients' },
  origin: { section: 'identification', category: 'origin', fieldKey: 'origin' },
  direction: { section: 'preparation', category: 'preparation', fieldKey: 'preparation' },
  warning: { section: 'warnings', category: 'warning', fieldKey: 'warnings' },
  productionMethod: { section: 'fishery', category: 'fishery', fieldKey: 'production_method' },
  fishingArea: { section: 'fishery', category: 'fishery', fieldKey: 'catch_area' },
  fishingMethod: { section: 'fishery', category: 'fishery', fieldKey: 'fishing_gear' }
};

function slugify(value) {
  return (
    normalizeText(value)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'item'
  );
}

function text(value) {
  const result = String(value ?? '').trim();
  return result && isMeaningful(result) ? result : null;
}

/** Colour + source for one translated field, from its status and confidence. */
function gradeTranslation(job) {
  const status = String(job?.status ?? '');

  if (GREEN_STATUSES.has(status)) {
    return { colorStatus: 'green', source: 'database', confidence: null };
  }

  if (RESEARCH_STATUSES.has(status)) {
    const score = Number(job?.source?.confidenceScore);
    const confidence = Number.isFinite(score) ? score : null;

    return job?.source?.confident
      ? { colorStatus: 'purple', source: 'ai_high', confidence }
      : { colorStatus: 'red', source: 'ai_uncertain', confidence };
  }

  // Partly from the approved database: purple rather than red, because the bulk
  // of the declaration is trusted. The unmatched terms carry their own items.
  if (PARTIAL_DATABASE_STATUSES.has(status)) {
    return { colorStatus: 'purple', source: 'ai_high', confidence: null };
  }

  return { colorStatus: 'red', source: 'ai_uncertain', confidence: null };
}

function field({
  key,
  label,
  section,
  category = 'general',
  value,
  languageCode = null,
  sourceText = null,
  colorStatus = 'green',
  confidence = null,
  source = 'database',
  message = null,
  required = false
}) {
  return {
    key,
    label,
    section,
    category,
    value: text(value),
    languageCode,
    sourceText: text(sourceText),
    colorStatus,
    confidence,
    source,
    message,
    required
  };
}

/**
 * Values taken straight from the supplier specification. They are not AI output,
 * so they are green — but the legally identifying ones still need a QA tick.
 */
function buildSpecFields(spec) {
  const rows = [
    ['article_number', 'Artikelnummer', 'identification', 'general', spec.articleNumber, true],
    ['product_name', 'Productnaam', 'identification', 'legal_product', spec.description || spec.legalProduct, true],
    ['legal_name', 'Wettelijke benaming (EN)', 'identification', 'legal_product', spec.legalProduct, true],
    ['brand', 'Merk', 'identification', 'general', spec.brand, false],
    ['supplier', 'Leveranciersnummer', 'identification', 'general', spec.supplierNumber, false],
    ['origin', 'Land van productie', 'identification', 'origin', spec.countryOfProduction, false],
    ['net_weight', 'Nettogewicht', 'identification', 'general', spec.logistics?.netWeight, true],
    ['ean', 'EAN', 'identification', 'general', spec.logistics?.ean, false],
    ['ingredients', 'Ingrediëntendeclaratie (EN)', 'composition', 'ingredient', spec.ingredientsDeclaration, true],
    ['preparation', 'Bereidingswijze (EN)', 'preparation', 'preparation', spec.storage?.directionForUse, false],
    ['warnings', 'Waarschuwing (EN)', 'warnings', 'warning', spec.storage?.warning, false],
    ['catch_area', 'Vangstgebied', 'fishery', 'fishery', spec.fish?.fishingArea || spec.fish?.fao, false],
    ['fishing_gear', 'Vangstmethode', 'fishery', 'fishery', spec.fish?.fishingMethod, false],
    ['scientific_name', 'Wetenschappelijke naam', 'fishery', 'fishery', spec.fish?.scientificName, false],
    ['production_method', 'Productiemethode', 'fishery', 'fishery', spec.fish?.productionMethod, false]
  ];

  return rows
    .filter(([, , , , value]) => text(value) !== null)
    .map(([key, label, section, category, value, required]) =>
      field({
        key,
        label,
        section,
        category,
        value,
        message: 'Rechtstreeks uit de productspecificatie (sheet 2. BASIC).',
        required
      })
    );
}

const NUTRITION_LABELS = {
  energyKj: 'Energie (kJ)',
  energyKcal: 'Energie (kcal)',
  fat: 'Vetten',
  saturates: 'waarvan verzadigde vetzuren',
  carbohydrate: 'Koolhydraten',
  sugars: 'waarvan suikers',
  protein: 'Eiwitten',
  salt: 'Zout',
  fiber: 'Vezels'
};

function buildNutrition(spec) {
  const nutrition = [];
  const fields = [];

  for (const [key, label] of Object.entries(NUTRITION_LABELS)) {
    const value = text(spec.nutrition?.[key]);
    if (value === null) continue;

    nutrition.push({ key, label, per100g: value, perPortion: null });
    fields.push(
      field({
        key: `nutrition.${key}`,
        label: `${label} (per 100 g)`,
        section: 'nutrition',
        category: 'nutrition',
        value,
        message: 'Rechtstreeks uit de productspecificatie.'
      })
    );
  }

  return { nutrition, fields };
}

/** One field per translation job per language, with its colour coding. */
function buildTranslationFields(translations) {
  const fields = [];

  for (const [jobKey, job] of Object.entries(translations ?? {})) {
    if (!job || SKIP_STATUSES.has(String(job.status))) continue;

    const meta = JOB_META[jobKey] ?? { section: 'translations', category: 'general', fieldKey: null };
    const grade = gradeTranslation(job);
    const sourceText = text(job.sourceText);
    const groupSlug = slugify(sourceText ?? job.fieldName ?? jobKey);

    for (const [agentCode, iso] of Object.entries(AGENT_TO_ISO)) {
      const value = text(job.translations?.[agentCode]);
      // Keep an empty target language visible: a missing translation is a red
      // review point, not something to hide.
      const missing = value === null;

      fields.push(
        field({
          key: `translation.${groupSlug}.${iso}`,
          label: `${job.fieldName ?? jobKey} — ${isoLanguageLabel(iso)}`,
          section: 'translations',
          category: meta.category,
          value,
          languageCode: iso,
          sourceText,
          colorStatus: missing ? 'red' : grade.colorStatus,
          confidence: grade.confidence,
          source: missing ? 'ai_uncertain' : grade.source,
          message: missing
            ? `Geen vertaling geproduceerd voor ${isoLanguageLabel(iso)}.`
            : (job.reviewReason || null),
          required: missing || grade.colorStatus !== 'green'
        })
      );
    }
  }

  return fields;
}

/** Every field becomes a review item; that is what makes the label editable. */
function fieldToReviewItem(labelField) {
  return {
    itemKey: `field:${labelField.key}`,
    fieldKey: labelField.key,
    title: labelField.label,
    section: labelField.section,
    category: labelField.category,
    languageCode: labelField.languageCode,
    sourceText: labelField.sourceText,
    proposedText: labelField.value,
    colorStatus: labelField.colorStatus,
    confidence: labelField.confidence,
    source: labelField.source,
    status: 'open',
    required: labelField.required,
    message: labelField.message
  };
}

/**
 * Standalone review points: the parser's QA warnings, and each ingredient term
 * that had no exact database hit — the "per term beoordeeld" requirement.
 */
function buildExtraReviewItems({ spec, translations }) {
  const items = [];

  for (const [index, warning] of (spec.qaWarnings ?? []).entries()) {
    const message = text(warning);
    if (!message) continue;

    items.push({
      itemKey: `spec-warning:${index}:${slugify(message)}`,
      fieldKey: null,
      title: message.length > 80 ? `${message.slice(0, 77)}...` : message,
      section: 'other',
      category: 'general',
      languageCode: null,
      sourceText: null,
      proposedText: null,
      colorStatus: 'red',
      confidence: null,
      source: 'ai_uncertain',
      status: 'open',
      required: true,
      message
    });
  }

  const unmatchedTerms = translations?.ingredients?.source?.unmatchedTerms ?? [];
  for (const term of unmatchedTerms) {
    const value = text(term);
    if (!value) continue;

    items.push({
      itemKey: `term:${slugify(value)}`,
      fieldKey: null,
      title: `Ingrediëntterm zonder databasehit: ${value}`,
      section: 'composition',
      category: 'ingredient',
      languageCode: null,
      sourceText: value,
      proposedText: value,
      colorStatus: 'red',
      confidence: null,
      source: 'ai_uncertain',
      status: 'open',
      // Context, not a separate gate: the ingredient declaration itself is a
      // required review point, and the term extractor produces some noise
      // ("White", "Preparation") that must not block finalizing a label.
      required: false,
      message:
        'Deze term staat niet in de goedgekeurde vertalingendatabase. Controleer hem in de declaratie hierboven; keur je hem daar goed, dan gaat de vertaling de database in.'
    });
  }

  // Notes the agent produced per field are useful context for the reviewer.
  for (const [jobKey, job] of Object.entries(translations ?? {})) {
    if (!job?.reviewRequired || !(job.notes ?? []).length) continue;

    const meta = JOB_META[jobKey] ?? { section: 'other', category: 'general' };
    items.push({
      itemKey: `notes:${jobKey}`,
      fieldKey: meta.fieldKey ?? null,
      title: `Toelichting agent — ${job.fieldName ?? jobKey}`,
      section: meta.section,
      category: meta.category,
      languageCode: null,
      sourceText: text(job.sourceText),
      proposedText: null,
      colorStatus: gradeTranslation(job).colorStatus,
      confidence: gradeTranslation(job).confidence,
      source: gradeTranslation(job).source,
      status: 'open',
      // Context, not a decision: never block finalizing on a note.
      required: false,
      message: job.notes.join('\n')
    });
  }

  return items;
}

/**
 * Makes keys unique by appending a counter on collision.
 *
 * Two different source values can normalise to the same slug (for example two
 * ingredient terms differing only in punctuation). Suffixing keeps both rows
 * instead of silently dropping one, and keeps the upsert on
 * (label_run_id, item_key) valid.
 */
function makeUniqueBy(items, getKey, setKey) {
  const seen = new Map();
  const collisions = [];

  return {
    items: items.map((item) => {
      const key = getKey(item);
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);

      if (count === 1) return item;

      collisions.push(key);
      return setKey(item, `${key}-${count}`);
    }),
    collisions
  };
}

export function buildPlatformLabelModel({ spec, translations, documents, emailReport }) {
  const specFields = buildSpecFields(spec);
  const { nutrition, fields: nutritionFields } = buildNutrition(spec);
  const translationFields = buildTranslationFields(translations);

  const uniqueFields = makeUniqueBy(
    [...specFields, ...translationFields, ...nutritionFields],
    (entry) => entry.key,
    (entry, key) => ({ ...entry, key })
  );
  const fields = uniqueFields.items;
  const valueOf = (key) => fields.find((entry) => entry.key === key)?.value ?? null;

  const labelModel = {
    version: 1,
    articleNumber: valueOf('article_number'),
    productName: valueOf('product_name'),
    legalName: valueOf('legal_name'),
    brand: valueOf('brand'),
    supplier: valueOf('supplier'),
    origin: valueOf('origin'),
    netWeight: valueOf('net_weight'),
    fields,
    nutrition
  };

  const uniqueItems = makeUniqueBy(
    [...fields.map(fieldToReviewItem), ...buildExtraReviewItems({ spec, translations })],
    (item) => item.itemKey,
    (item, itemKey) => ({ ...item, itemKey })
  );
  const reviewItems = uniqueItems.items;

  const collisions = [...uniqueFields.collisions, ...uniqueItems.collisions];
  if (collisions.length > 0) {
    console.log(`Sleutelbotsingen opgelost met suffix: ${[...new Set(collisions)].join(', ')}`);
  }

  const artifacts = [
    { artifactType: 'source_spec', label: 'Geüploade productspecificatie', path: documents?.input?.path || null, url: documents?.input?.webUrl || null },
    { artifactType: 'draft_docx', label: 'Concept-label (Word)', path: documents?.label?.path || null, url: documents?.label?.webUrl || null },
    { artifactType: 'report', label: 'Rapportage Label Agent', path: documents?.report?.path || null, url: documents?.report?.webUrl || null }
  ].filter((artifact) => artifact.path || artifact.url);

  return {
    labelModel,
    reviewItems,
    artifacts,
    previewText: emailReport?.text ?? null,
    previewHtml: emailReport?.html ?? null,
    emailReport: emailReport?.text ?? null
  };
}
