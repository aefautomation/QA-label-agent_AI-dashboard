import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from './config.js';
import { parseSpecification } from './excel/specParser.js';
import { loadTranslationDb } from './translation/translationDb.js';
import { translateField } from './translation/translator.js';
import { fillDocxTemplate } from './docx/docxTemplate.js';
import { SharePointClient } from './sharepoint/graphClient.js';
import { appendRunLog } from './runLog.js';
import { isMeaningful, safeFilePart } from './utils/normalize.js';

function makeRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const random = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${random}`;
}

async function copyOrDownloadAsset({ sharePointClient, sharePointPath, localPath, targetPath }) {
  if (sharePointClient?.enabled && sharePointPath) {
    await sharePointClient.downloadToFile(sharePointPath, targetPath);
    return {
      path: targetPath,
      source: 'sharepoint',
      sharePointPath
    };
  }

  if (!localPath) {
    throw new Error(`Asset ontbreekt: geen SharePoint-pad of lokaal pad ingesteld voor ${targetPath}.`);
  }

  await fs.copyFile(localPath, targetPath);
  return {
    path: targetPath,
    source: 'local',
    localPath
  };
}

async function resolveAssets({ config, runDir, sharePointClient, templateType }) {
  const assetDir = path.join(runDir, 'assets');
  await fs.mkdir(assetDir, { recursive: true });

  const translationDb = await copyOrDownloadAsset({
    sharePointClient,
    sharePointPath: config.sharePoint.paths.translationDb,
    localPath: config.local.translationDbPath,
    targetPath: path.join(assetDir, 'Labels_13_talen.xlsx')
  });

  const templateName = {
    normal: 'template-normal.docx',
    frozen: 'template-frozen.docx',
    fisheryFrozen: 'template-fishery-frozen.docx'
  }[templateType];

  const template = await copyOrDownloadAsset({
    sharePointClient,
    sharePointPath: config.sharePoint.paths.templates[templateType],
    localPath: config.local.templates[templateType],
    targetPath: path.join(assetDir, templateName)
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
      sources: field.source?.sources || []
    }));
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
      candidates: []
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

    translations[key] = await translateField({
      ...job,
      translationDb,
      openaiConfig,
      productContext
    });
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

export async function runLabelJob({
  specPath,
  sharePointSpecPath,
  source = {},
  outputRoot,
  config = getConfig()
}) {
  const runId = makeRunId();
  const timestamp = new Date().toISOString();
  const root = outputRoot || config.outputRoot;
  const runDir = path.join(root, runId);
  await fs.mkdir(runDir, { recursive: true });

  const sharePointClient = new SharePointClient(config.sharePoint);
  const resolvedSpecPath = await resolveSpecPath({
    sharePointSpecPath,
    specPath,
    runDir,
    sharePointClient
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

  await fillDocxTemplate({
    templatePath: assets.template.path,
    outputPath,
    spec,
    translations
  });

  let sharePointOutput = null;
  let sharePointOutputPath = '';
  if (sharePointClient.enabled) {
    const day = timestamp.slice(0, 10);
    sharePointOutputPath = `${config.sharePoint.paths.outputFolder}/${day}/${outputFileName}`;
    sharePointOutput = await sharePointClient.uploadFile(
      outputPath,
      sharePointOutputPath,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  }

  const run = {
    runId,
    timestamp,
    source,
    spec,
    translations,
    reviewRequired: reviewItems.length > 0,
    reviewItems,
    outputPath,
    sharePointOutputPath,
    sharePointWebUrl: sharePointOutput?.webUrl || ''
  };

  const runLogPath = await appendRunLog({ run, config, sharePointClient });

  return {
    runId,
    timestamp,
    templateType: spec.templateType,
    articleNumber: spec.articleNumber,
    legalProduct: spec.legalProduct,
    outputPath,
    sharePointOutputPath,
    sharePointWebUrl: sharePointOutput?.webUrl || '',
    runLogPath,
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
