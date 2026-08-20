// Orchestrates one label run: parse spec, select assets, translate, fill DOCX, upload and log.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig, hasSharePointConfig, hasSupabaseConfig } from './config.js';
import { parseSpecification } from './excel/specParser.js';
import { loadTranslationDb } from './translation/translationDb.js';
import { loadTranslationDbFromSupabase } from './translation/supabaseTranslationDb.js';
import { translateField } from './translation/translator.js';
import { translateIngredientsDeclaration } from './translation/ingredientDeclaration.js';
import { fillDocxTemplate } from './docx/docxTemplate.js';
import { buildEmailReport } from './report/emailReport.js';
import { SharePointClient } from './sharepoint/graphClient.js';
import {
  DOCUMENT_BUCKET,
  SupabaseStorageClient,
  documentObjectName
} from './storage/supabaseStorage.js';
import { buildPlatformLabelModel } from './platform/labelModel.js';
import { LabelRunStore } from './platform/labelRunStore.js';
import { appendRunLog } from './runLog.js';
import { isMeaningful, safeFilePart } from './utils/normalize.js';

export function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

async function downloadSharePointAsset({ sharePointClient, sharePointPath, targetPath, label }) {
  if (!sharePointClient?.enabled) {
    throw new Error('SharePoint/Teams is verplicht geconfigureerd; lokale templates of databases worden niet meer gebruikt.');
  }
  if (!sharePointPath) {
    throw new Error(`SharePoint-pad ontbreekt voor ${label}. Controleer de SP_* Railway variables.`);
  }

  await sharePointClient.downloadToFile(sharePointPath, targetPath);
  return {
    path: targetPath,
    source: 'sharepoint',
    sharePointPath
  };
}

async function resolveAssets({ config, runDir, sharePointClient, storageClient, templateType }) {
  const assetDir = path.join(runDir, 'assets');
  await fs.mkdir(assetDir, { recursive: true });

  const useSupabase = hasSupabaseConfig(config);

  // The translations come from Supabase when it is configured; only then is the
  // SharePoint workbook still needed.
  const translationDb = useSupabase
    ? null
    : await downloadSharePointAsset({
        sharePointClient,
        sharePointPath: config.sharePoint.paths.translationDb,
        targetPath: path.join(assetDir, 'Labels_13_talen.xlsx'),
        label: 'vertalingendatabase'
      });

  const templateName = {
    normal: 'template-normal.docx',
    frozen: 'template-frozen.docx',
    fisheryFrozen: 'template-fishery-frozen.docx'
  }[templateType];
  const templatePath = path.join(assetDir, templateName);

  const template = useSupabase
    ? await storageClient.downloadTemplate(templateType, templatePath)
    : await downloadSharePointAsset({
        sharePointClient,
        sharePointPath: config.sharePoint.paths.templates[templateType],
        targetPath: templatePath,
        label: `sjabloon ${templateType}`
      });

  return { translationDb, template };
}

function reviewItemsFromTranslations(translations) {
  return Object.values(translations)
    .filter((field) => field?.reviewRequired)
    .map((field) => ({
      field: field.fieldName,
      reason: field.reviewReason,
      status: field.status,
      sourceText: field.sourceText,
      notes: field.notes || [],
      model: field.source?.model || '',
      modelTier: field.source?.modelTier || '',
      modelEscalated: Boolean(field.source?.modelEscalated),
      modelReason: field.source?.modelReason || '',
      confidence: field.source?.confidence || '',
      confidenceScore: field.source?.confidenceScore ?? '',
      confidenceReason: field.source?.confidenceReason || '',
      confident: Boolean(field.source?.confident),
      sources: field.source?.sources || []
    }));
}

function warningCandidates(sourceText) {
  const text = String(sourceText || '').trim();
  const eNumbers = text.match(/\bE\s*\d+[a-z]?\b/gi) || [];
  const candidates = [text];

  if (/may\s+have\s+an\s+adverse\s+effect\s+on\s+activity\s+and\s+attention\s+(?:in|of)\s+children/i.test(text)) {
    candidates.push(
      eNumbers.length > 1
        ? 'E... and E...may have an adverse effect on activity and attention of children'
        : 'E... may have an adverse effect on activity and attention of children.'
    );
  }

  return candidates;
}

export async function buildTranslationsForSpec({ spec, translationDb, openaiConfig }) {
  const productContext = {
    articleNumber: spec.articleNumber,
    brand: spec.brand,
    legalProduct: spec.legalProduct,
    countryOfProduction: spec.countryOfProduction,
    isFrozen: spec.isFrozen,
    isFisheryProduct: spec.isFisheryProduct,
    allergens: spec.allergens
      .filter((row) => isMeaningful(row.intentional) && row.intentional !== '0')
      .map((row) => row.allergen),
    additives: spec.additives.map((row) => `${row.eNumber} ${row.name} ${row.function}`.trim()).filter(Boolean)
  };

  const jobs = {
    productName: {
      fieldName: 'Productnaam / wettelijke benaming',
      fieldKind: 'legalProduct',
      sourceText: spec.legalProduct || spec.description,
      candidates: [spec.description]
    },
    ingredients: {
      fieldName: 'Ingrediëntendeclaratie',
      sourceText: spec.ingredientsDeclaration.replace(/^ingredients:\s*/i, ''),
      candidates: [spec.ingredientsDeclaration]
    },
    origin: {
      fieldName: 'Herkomst / land van productie',
      fieldKind: 'origin',
      sourceText: spec.countryOfProduction,
      candidates: [spec.countryOfProduction?.toUpperCase(), spec.countryOfProduction?.toLowerCase()]
    },
    direction: {
      fieldName: 'Bereidingswijze',
      fieldKind: 'preparation',
      sourceText: spec.storage.directionForUse,
      candidates: []
    },
    warning: {
      fieldName: 'Waarschuwing',
      fieldKind: 'warning',
      sourceText: spec.storage.warning,
      candidates: warningCandidates(spec.storage.warning)
    },
    productionMethod: {
      fieldName: 'Visserij productiemethode',
      fieldKind: 'fishery',
      sourceText: spec.fish.productionMethod,
      candidates: []
    },
    fishingArea: {
      fieldName: 'Visserij vangstgebied',
      fieldKind: 'fishery',
      sourceText: spec.fish.fishingArea || spec.fish.fao27Detail || spec.fish.fao37Detail || spec.fish.fao,
      candidates: [spec.fish.fao, spec.fish.fao27Detail, spec.fish.fao37Detail]
    },
    fishingMethod: {
      fieldName: 'Visserij vangstmethode',
      fieldKind: 'fishery',
      sourceText: spec.fish.fishingMethod,
      candidates: []
    }
  };

  const translations = {};
  for (const [key, job] of Object.entries(jobs)) {
    if (!isMeaningful(job.sourceText)) {
      translations[key] = {
        fieldName: job.fieldName,
        sourceText: '',
        status: 'empty',
        trusted: true,
        translations: {},
        reviewRequired: false,
        notes: []
      };
      continue;
    }

    if (spec.templateType !== 'fisheryFrozen' && ['productionMethod', 'fishingArea', 'fishingMethod'].includes(key)) {
      translations[key] = {
        fieldName: job.fieldName,
        sourceText: '',
        status: 'not_applicable',
        trusted: true,
        translations: {},
        reviewRequired: false,
        notes: []
      };
      continue;
    }

    if (key === 'ingredients') {
      translations[key] = await translateIngredientsDeclaration({
        ...job,
        translationDb,
        openaiConfig,
        productContext
      });
    } else {
      translations[key] = await translateField({
        ...job,
        translationDb,
        openaiConfig,
        productContext
      });
    }
  }

  return translations;
}

async function resolveSpecPath({
  sharePointSpecPath,
  storageSpecPath,
  specPath,
  runDir,
  sharePointClient,
  storageClient
}) {
  // The platform may hand over a spec it already uploaded to Storage.
  if (storageSpecPath) {
    const localSpecPath = path.join(runDir, 'input', path.posix.basename(storageSpecPath));
    await storageClient.downloadToFile(DOCUMENT_BUCKET, storageSpecPath, localSpecPath);
    return localSpecPath;
  }

  if (sharePointSpecPath) {
    const localSpecPath = path.join(runDir, 'input', path.posix.basename(sharePointSpecPath));
    await sharePointClient.downloadToFile(sharePointSpecPath, localSpecPath);
    return localSpecPath;
  }

  if (!specPath) {
    throw new Error('Geen specificatie ontvangen. Upload multipart veld "spec", of stuur "storageSpecPath"/"sharePointSpecPath".');
  }
  return specPath;
}

/** Archives the uploaded specification next to the label it produced. */
async function archiveUploadedSpec({
  useSupabase,
  storageClient,
  sharePointClient,
  config,
  specPath,
  source,
  runId,
  timestamp
}) {
  if (!specPath || source.kind !== 'multipart') return { path: '', webUrl: '' };

  const day = timestamp.slice(0, 10);
  const originalName = source.originalFileName || path.basename(specPath);
  const fileName = `${runId}-${safeFilePart(originalName)}`;

  if (useSupabase) {
    const objectName = documentObjectName({ kind: 'input', day, runId, fileName });
    await storageClient.uploadSpec(specPath, objectName);
    return { path: objectName, webUrl: '' };
  }

  const sharePointPath = `${config.sharePoint.paths.inputFolder}/${day}/${fileName}`;
  const upload = await sharePointClient.uploadFile(
    specPath,
    sharePointPath,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );

  return { path: sharePointPath, webUrl: upload?.webUrl || '' };
}

export async function runLabelJob({
  specPath,
  sharePointSpecPath,
  storageSpecPath,
  source = {},
  config = getConfig(),
  runId: providedRunId
}) {
  const useSupabase = hasSupabaseConfig(config);

  // Supabase-only is the AEF AI Platform setup; SharePoint remains supported so
  // the original Make/email flow keeps working against the same code.
  if (!useSupabase && !hasSharePointConfig(config)) {
    throw new Error(
      'Geen opslag geconfigureerd. Zet SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (AEF AI Platform), of de SHAREPOINT_*/SP_* variables.'
    );
  }

  const runId = providedRunId || makeRunId();
  const timestamp = new Date().toISOString();
  const runDir = path.join(config.tmpRoot, 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const sharePointClient = new SharePointClient(config.sharePoint);
  const storageClient = new SupabaseStorageClient(config.supabase);

  // Platform bookkeeping. The row is created up front so a failure halfway is
  // visible to QA instead of silently disappearing.
  const runStore = new LabelRunStore(config.supabase);
  let runRowId = null;

  if (runStore.enabled) {
    runRowId = await runStore.ensureRun({
      labelRunId: source.labelRunId,
      agentRunId: runId,
      uploadedFileName: source.originalFileName,
      createdBy: source.createdBy
    });
    await runStore.markRunning({ runRowId, agentRunId: runId });
  }

  try {
    return await executeLabelJob({
      runId,
      timestamp,
      runDir,
      specPath,
      sharePointSpecPath,
      storageSpecPath,
      source,
      config,
      useSupabase,
      sharePointClient,
      storageClient,
      runStore,
      runRowId
    });
  } catch (error) {
    await runStore.markFailed({ runRowId, message: error.message });
    throw error;
  }
}

async function executeLabelJob({
  runId,
  timestamp,
  runDir,
  specPath,
  sharePointSpecPath,
  storageSpecPath,
  source,
  config,
  useSupabase,
  sharePointClient,
  storageClient,
  runStore,
  runRowId
}) {
  const resolvedSpecPath = await resolveSpecPath({
    sharePointSpecPath,
    storageSpecPath,
    specPath,
    runDir,
    sharePointClient,
    storageClient
  });
  const archivedSpec = await archiveUploadedSpec({
    useSupabase,
    storageClient,
    sharePointClient,
    config,
    specPath: resolvedSpecPath,
    source,
    runId,
    timestamp
  });

  const spec = parseSpecification(resolvedSpecPath);
  const assets = await resolveAssets({
    config,
    runDir,
    sharePointClient,
    storageClient,
    templateType: spec.templateType
  });

  const translationDb = hasSupabaseConfig(config)
    ? await loadTranslationDbFromSupabase(config.supabase)
    : loadTranslationDb(assets.translationDb.path);
  spec.qaWarnings.push(...translationDb.diagnostics);

  const translations = await buildTranslationsForSpec({
    spec,
    translationDb,
    openaiConfig: config.openai
  });

  const reviewItems = [
    ...spec.qaWarnings.map((warning) => ({ field: 'Specificatie', reason: warning, status: 'qa_warning' })),
    ...reviewItemsFromTranslations(translations)
  ];

  const outputFileName = `${safeFilePart(spec.articleNumber)}-${safeFilePart(spec.legalProduct || spec.description)}-${runId}.docx`;
  const outputPath = path.join(runDir, outputFileName);
  const reportFileName = `${safeFilePart(spec.articleNumber)}-${safeFilePart(spec.legalProduct || spec.description)}-${runId}-rapportage.txt`;
  const reportPath = path.join(runDir, reportFileName);

  await fillDocxTemplate({
    templatePath: assets.template.path,
    outputPath,
    spec,
    translations
  });

  const day = timestamp.slice(0, 10);
  let labelLocation = { path: '', webUrl: '' };
  let reportLocation = { path: '', webUrl: '' };

  if (useSupabase) {
    labelLocation.path = documentObjectName({
      kind: 'output',
      day,
      runId,
      fileName: outputFileName
    });
    await storageClient.uploadLabel(outputPath, labelLocation.path);
    reportLocation.path = documentObjectName({
      kind: 'report',
      day,
      runId,
      fileName: reportFileName
    });
  } else {
    labelLocation.path = `${config.sharePoint.paths.outputFolder}/${day}/${outputFileName}`;
    const upload = await sharePointClient.uploadFile(
      outputPath,
      labelLocation.path,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    labelLocation.webUrl = upload?.webUrl || '';
    reportLocation.path = `${config.sharePoint.paths.outputFolder}/${day}/${reportFileName}`;
  }

  const run = {
    runId,
    timestamp,
    source,
    spec,
    translations,
    reviewRequired: reviewItems.length > 0,
    reviewItems,
    sharePointInputPath: sharePointSpecPath || archivedSpec.path,
    sharePointInputWebUrl: archivedSpec.webUrl,
    sharePointOutputPath: labelLocation.path,
    sharePointWebUrl: labelLocation.webUrl
  };

  const emailReport = buildEmailReport(run);
  await fs.writeFile(reportPath, emailReport.text, 'utf8');

  if (useSupabase) {
    await storageClient.uploadReport(reportPath, reportLocation.path);
  } else {
    const upload = await sharePointClient.uploadFile(
      reportPath,
      reportLocation.path,
      'text/plain; charset=utf-8'
    );
    reportLocation.webUrl = upload?.webUrl || '';
  }

  // The Excel run log is a SharePoint artefact; on the platform its role is
  // taken by the label_runs table.
  if (!useSupabase) {
    await appendRunLog({ run, config, sharePointClient });
  }

  const documents = {
    backend: useSupabase ? 'supabase-storage' : 'sharepoint',
    bucket: useSupabase ? DOCUMENT_BUCKET : '',
    input: { path: sharePointSpecPath || archivedSpec.path, webUrl: archivedSpec.webUrl },
    label: labelLocation,
    report: reportLocation
  };

  // The reviewable label model: this is what QA edits in the platform, instead
  // of editing the Word document.
  const platformModel = buildPlatformLabelModel({
    spec,
    translations,
    documents,
    emailReport
  });

  if (runStore.enabled && runRowId) {
    await runStore.writeResult({
      runRowId,
      agentRunId: runId,
      spec,
      platformModel,
      documents
    });
  }

  await fs.rm(runDir, { recursive: true, force: true });

  return {
    runId,
    labelRunId: runRowId,
    timestamp,
    templateType: spec.templateType,
    articleNumber: spec.articleNumber,
    legalProduct: spec.legalProduct,
    // Backend-neutral locations. Storage paths are private; the platform signs
    // them on demand when a QA employee opens a document.
    documents,
    // The reviewable model, also written to label_runs/label_review_items.
    platformModel,
    // Kept for the existing Make/email flow.
    sharePointInputPath: sharePointSpecPath || archivedSpec.path,
    sharePointInputWebUrl: archivedSpec.webUrl,
    sharePointOutputPath: labelLocation.path,
    sharePointWebUrl: labelLocation.webUrl,
    sharePointReportPath: reportLocation.path,
    sharePointReportWebUrl: reportLocation.webUrl,
    emailReport,
    reviewRequired: reviewItems.length > 0,
    reviewItems,
    extracted: {
      supplierNumber: spec.supplierNumber,
      brand: spec.brand,
      countryOfProduction: spec.countryOfProduction,
      isFrozen: spec.isFrozen,
      isFisheryProduct: spec.isFisheryProduct,
      nutrition: spec.nutrition,
      ean: spec.logistics.ean,
      netWeight: spec.logistics.netWeight
    }
  };
}
