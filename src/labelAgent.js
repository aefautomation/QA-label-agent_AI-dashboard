// Orchestrates one label run: parse spec, select assets, translate, fill DOCX, upload and log.
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig, hasSharePointConfig } from './config.js';
import { parseSpecification } from './excel/specParser.js';
import { loadTranslationDb } from './translation/translationDb.js';
import { translateField } from './translation/translator.js';
import { translateIngredientsDeclaration } from './translation/ingredientDeclaration.js';
import { fillDocxTemplate } from './docx/docxTemplate.js';
import { buildEmailReport } from './report/emailReport.js';
import { SharePointClient } from './sharepoint/graphClient.js';
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

async function resolveAssets({ config, runDir, sharePointClient, templateType }) {
  const assetDir = path.join(runDir, 'assets');
  await fs.mkdir(assetDir, { recursive: true });

  const translationDb = await downloadSharePointAsset({
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

  const template = await downloadSharePointAsset({
    sharePointClient,
    sharePointPath: config.sharePoint.paths.templates[templateType],
    targetPath: path.join(assetDir, templateName),
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

async function buildTranslations({ spec, translationDb, openaiConfig }) {
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
      sourceText: spec.countryOfProduction,
      candidates: [spec.countryOfProduction?.toUpperCase(), spec.countryOfProduction?.toLowerCase()]
    },
    direction: {
      fieldName: 'Bereidingswijze',
      sourceText: spec.storage.directionForUse,
      candidates: []
    },
    warning: {
      fieldName: 'Waarschuwing',
      sourceText: spec.storage.warning,
      candidates: warningCandidates(spec.storage.warning)
    },
    productionMethod: {
      fieldName: 'Visserij productiemethode',
      sourceText: spec.fish.productionMethod,
      candidates: []
    },
    fishingArea: {
      fieldName: 'Visserij vangstgebied',
      sourceText: spec.fish.fishingArea || spec.fish.fao27Detail || spec.fish.fao37Detail || spec.fish.fao,
      candidates: [spec.fish.fao, spec.fish.fao27Detail, spec.fish.fao37Detail]
    },
    fishingMethod: {
      fieldName: 'Visserij vangstmethode',
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

async function resolveSpecPath({ sharePointSpecPath, specPath, runDir, sharePointClient }) {
  if (sharePointSpecPath) {
    const localSpecPath = path.join(runDir, 'input', path.posix.basename(sharePointSpecPath));
    await sharePointClient.downloadToFile(sharePointSpecPath, localSpecPath);
    return localSpecPath;
  }

  if (!specPath) throw new Error('Geen specificatie ontvangen. Upload multipart veld "spec" of stuur "sharePointSpecPath".');
  return specPath;
}

async function uploadMultipartSpecToSharePoint({ sharePointClient, config, specPath, source, runId, timestamp }) {
  if (!specPath || source.kind !== 'multipart') {
    return {
      path: '',
      webUrl: ''
    };
  }

  const day = timestamp.slice(0, 10);
  const originalName = source.originalFileName || path.basename(specPath);
  const fileName = `${runId}-${safeFilePart(originalName)}`;
  const sharePointPath = `${config.sharePoint.paths.inputFolder}/${day}/${fileName}`;
  const upload = await sharePointClient.uploadFile(
    specPath,
    sharePointPath,
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );

  return {
    path: sharePointPath,
    webUrl: upload?.webUrl || ''
  };
}

export async function runLabelJob({
  specPath,
  sharePointSpecPath,
  source = {},
  config = getConfig(),
  runId: providedRunId
}) {
  if (!hasSharePointConfig(config)) {
    throw new Error('SharePoint/Teams configuratie ontbreekt. Deze agent draait SharePoint-only.');
  }

  const runId = providedRunId || makeRunId();
  const timestamp = new Date().toISOString();
  const runDir = path.join(config.tmpRoot, 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });

  const sharePointClient = new SharePointClient(config.sharePoint);
  const resolvedSpecPath = await resolveSpecPath({
    sharePointSpecPath,
    specPath,
    runDir,
    sharePointClient
  });
  const sharePointInput = await uploadMultipartSpecToSharePoint({
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
    templateType: spec.templateType
  });

  const translationDb = loadTranslationDb(assets.translationDb.path);
  spec.qaWarnings.push(...translationDb.diagnostics);

  const translations = await buildTranslations({
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

  let sharePointOutput = null;
  let sharePointOutputPath = '';
  let sharePointReport = null;
  let sharePointReportPath = '';
  const day = timestamp.slice(0, 10);
  sharePointOutputPath = `${config.sharePoint.paths.outputFolder}/${day}/${outputFileName}`;
  sharePointOutput = await sharePointClient.uploadFile(
    outputPath,
    sharePointOutputPath,
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  );
  sharePointReportPath = `${config.sharePoint.paths.outputFolder}/${day}/${reportFileName}`;

  const run = {
    runId,
    timestamp,
    source,
    spec,
    translations,
    reviewRequired: reviewItems.length > 0,
    reviewItems,
    sharePointInputPath: sharePointSpecPath || sharePointInput.path,
    sharePointInputWebUrl: sharePointInput.webUrl,
    sharePointOutputPath,
    sharePointWebUrl: sharePointOutput?.webUrl || ''
  };

  const emailReport = buildEmailReport(run);
  await fs.writeFile(reportPath, emailReport.text, 'utf8');

  sharePointReport = await sharePointClient.uploadFile(
    reportPath,
    sharePointReportPath,
    'text/plain; charset=utf-8'
  );

  await appendRunLog({ run, config, sharePointClient });
  await fs.rm(runDir, { recursive: true, force: true });

  return {
    runId,
    timestamp,
    templateType: spec.templateType,
    articleNumber: spec.articleNumber,
    legalProduct: spec.legalProduct,
    sharePointInputPath: sharePointSpecPath || sharePointInput.path,
    sharePointInputWebUrl: sharePointInput.webUrl,
    sharePointOutputPath,
    sharePointWebUrl: sharePointOutput?.webUrl || '',
    sharePointReportPath,
    sharePointReportWebUrl: sharePointReport?.webUrl || '',
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
