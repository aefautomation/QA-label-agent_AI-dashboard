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

// Fully from the approved translation database, so trusted.
const GREEN_STATUSES = new Set(['database', 'database_terms']);
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
  required = false,
  groupKey = null,
  segments = null,
  readOnly = false
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
    required,
    // Which label field this belongs to: the English source from the
    // specification and its translations share one groupKey.
    groupKey,
    // Declaration split per term, each flagged when uncertain.
    segments: Array.isArray(segments) && segments.length > 0 ? segments : null,
    // Shown on the label but not editable: an assembled value, whose parts are
    // reviewed individually.
    readOnly
  };
}

/**
 * Which translation job a specification field is the English source of. Sharing
 * the groupKey puts the source and its 13 translations in one group in the QA
 * panel, instead of scattering the same declaration over two sections.
 */
const SPEC_FIELD_GROUPS = {
  legal_name: 'productName',
  ingredients: 'ingredients',
  origin: 'origin',
  preparation: 'direction',
  warnings: 'warning',
  catch_area: 'fishingArea',
  fishing_gear: 'fishingMethod',
  production_method: 'productionMethod'
};

/**
 * Values taken straight from the supplier specification. They are not AI output,
 * so they are green — but the legally identifying ones still need a QA tick.
 *
 * No explanatory message is attached: "from the specification" is already implied
 * by the green/database badge, and repeating it on every field only makes the
 * review panel noisier.
 */
function buildSpecFields(spec) {
  const rows = [
    ['article_number', 'Artikelnummer', 'identification', 'general', spec.articleNumber, true],
    ['product_name', 'Productnaam', 'identification', 'legal_product', spec.description || spec.legalProduct, true],
    ['legal_name', 'Wettelijke benaming', 'identification', 'legal_product', spec.legalProduct, true],
    ['brand', 'Merk', 'identification', 'general', spec.brand, false],
    ['supplier', 'Leveranciersnummer', 'identification', 'general', spec.supplierNumber, false],
    ['origin', 'Land van productie', 'identification', 'origin', spec.countryOfProduction, false],
    ['net_weight', 'Nettogewicht', 'identification', 'general', spec.logistics?.netWeight, true],
    ['ean', 'EAN', 'identification', 'general', spec.logistics?.ean, false],
    ['ingredients', 'Ingrediëntendeclaratie', 'composition', 'ingredient', spec.ingredientsDeclaration, true],
    ['preparation', 'Bereidingswijze', 'preparation', 'preparation', spec.storage?.directionForUse, false],
    ['warnings', 'Waarschuwing', 'warnings', 'warning', spec.storage?.warning, false],
    ['catch_area', 'Vangstgebied', 'fishery', 'fishery', spec.fish?.fishingArea || spec.fish?.fao, false],
    ['fishing_gear', 'Vangstmethode', 'fishery', 'fishery', spec.fish?.fishingMethod, false],
    ['scientific_name', 'Wetenschappelijke naam', 'fishery', 'fishery', spec.fish?.scientificName, false],
    ['production_method', 'Productiemethode', 'fishery', 'fishery', spec.fish?.productionMethod, false]
  ];

  const legalName = text(spec.legalProduct);

  return rows
    .filter(([key, , , , value]) => {
      if (text(value) === null) return false;
      // product_name and legal_name collapse to the same string whenever the
      // specification has no separate description — then showing both is noise.
      if (key === 'product_name' && text(value) === legalName) return false;
      return true;
    })
    .map(([key, label, section, category, value, required]) =>
      field({
        key,
        label,
        section,
        category,
        value,
        required,
        groupKey: SPEC_FIELD_GROUPS[key] ?? null
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
        value
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

    const meta = JOB_META[jobKey] ?? { section: 'other', category: 'general', fieldKey: null };
    const grade = gradeTranslation(job);
    const isAssembled = jobKey === 'ingredients';
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
          // Live in the section of the field they translate, not in a separate
          // "translations" bucket: everything about one declaration together.
          section: meta.section,
          category: meta.category,
          value,
          languageCode: iso,
          sourceText,
          colorStatus: missing ? 'red' : grade.colorStatus,
          confidence: grade.confidence,
          source: missing ? 'ai_uncertain' : grade.source,
          message: missing
            ? `Geen vertaling geproduceerd voor ${isoLanguageLabel(iso)}.`
            : null,
          required: isAssembled ? false : missing || grade.colorStatus !== 'green',
          groupKey: jobKey,
          // The ingredient declaration is assembled from database terms plus AI
          // terms. Editing the whole string would overwrite that composition, so
          // QA reviews the individual terms instead (see buildTermFields).
          readOnly: isAssembled,
          // Per-term breakdown of the ingredient declaration: each part carries a
          // red flag when that term had no exact database hit, so QA reviews a
          // handful of words instead of re-reading the whole declaration.
          segments: job.languageSegments?.[agentCode] ?? null
        })
      );
    }
  }

  return fields;
}

/**
 * Keeps only the longest form of each term.
 *
 * The terminology extractor also emits the parts of a compound ("Protein" and
 * "Preparation" next to "Liquid Protein Preparation"). Every term becomes 13
 * review rows, so the fragments would triple the review work while adding
 * nothing to the translation database.
 */
function maximalTerms(terms) {
  const cleaned = [];
  const seen = new Set();

  for (const raw of terms) {
    const term = text(raw);
    if (!term) continue;

    const key = normalizeText(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    cleaned.push(term);
  }

  const padded = (value) => ` ${normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim()} `;

  return cleaned.filter((term) => {
    const needle = padded(term);
    return !cleaned.some(
      (other) => other.length > term.length && padded(other).includes(needle)
    );
  });
}

/**
 * One group per ingredient term that had no exact database hit, with the AI's
 * proposal per language.
 *
 * This is the point of the whole exercise: a full declaration never recurs on
 * another product, but "protein isolate" or "rice vinegar" does. Approving these
 * is what makes the next label greener.
 */
function buildTermFields(translations) {
  const job = translations?.ingredients;
  const unmatched = maximalTerms(job?.source?.unmatchedTerms ?? []);
  if (unmatched.length === 0) return [];

  const termTranslations = job.termTranslations ?? {};
  const fields = [];

  for (const term of unmatched) {
    const sourceTerm = text(term);
    if (!sourceTerm) continue;

    const proposal = termTranslations[term] ?? termTranslations[sourceTerm] ?? null;
    const confidence = Number(proposal?.confidenceScore);
    const grade = !proposal
      ? { colorStatus: 'red', source: 'ai_uncertain', confidence: null }
      : proposal.confident
        ? { colorStatus: 'purple', source: 'ai_high', confidence: Number.isFinite(confidence) ? confidence : null }
        : { colorStatus: 'red', source: 'ai_uncertain', confidence: Number.isFinite(confidence) ? confidence : null };

    const groupKey = `term:${slugify(sourceTerm)}`;

    for (const [agentCode, iso] of Object.entries(AGENT_TO_ISO)) {
      // Without an AI proposal the English term is copied, which is a starting
      // point for QA rather than a translation.
      const raw = proposal?.translations?.[agentCode];
      const value = text(raw) === sourceTerm && iso !== 'en' ? null : text(raw);

      fields.push(
        field({
          key: `${groupKey}.${iso}`,
          label: `${sourceTerm} — ${isoLanguageLabel(iso)}`,
          section: 'composition',
          category: 'ingredient',
          value,
          languageCode: iso,
          sourceText: sourceTerm,
          colorStatus: value ? grade.colorStatus : 'red',
          confidence: grade.confidence,
          source: value ? grade.source : 'ai_uncertain',
          message: null,
          // The declaration itself is not reviewable, so these terms are the only
          // gate on it: an uncertain ingredient term must be checked before the
          // label can be finalized.
          required: true,
          groupKey
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
    message: labelField.message,
    groupKey: labelField.groupKey,
    segments: labelField.segments
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
  const termFields = buildTermFields(translations);

  const uniqueFields = makeUniqueBy(
    [...specFields, ...translationFields, ...termFields, ...nutritionFields],
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

  // A field that only carries the English source of a translation group is not a
  // review point of its own: QA approves what goes on the label (the 13
  // languages), and the source text is already shown in the group header.
  const groupedLanguages = new Set(
    fields.filter((entry) => entry.groupKey && entry.languageCode).map((entry) => entry.groupKey)
  );
  const reviewableFields = fields.filter((entry) => {
    // Assembled values are display-only; their parts carry the review.
    if (entry.readOnly) return false;
    // A field that only carries the English source of a translation group is not
    // a review point of its own either.
    return !(entry.groupKey && !entry.languageCode && groupedLanguages.has(entry.groupKey));
  });

  const uniqueItems = makeUniqueBy(
    [...reviewableFields.map(fieldToReviewItem), ...buildExtraReviewItems({ spec, translations })],
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
