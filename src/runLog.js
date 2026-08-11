// Appends each label run to the SharePoint Excel run log through a temporary working copy.
import fs from 'node:fs/promises';
import path from 'node:path';
import ExcelJS from 'exceljs';

const HEADERS = [
  'Run ID',
  'Timestamp',
  'Source',
  'Email subject',
  'Article number',
  'Supplier number',
  'Brand',
  'Legal product',
  'Template type',
  'Input SharePoint path',
  'Output SharePoint path',
  'Review required',
  'Review item count',
  'Database translations',
  'Fallback translations',
  'Warnings',
  'OpenAI models',
  'Review model escalations'
];

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function setupWorksheet(workbook) {
  const worksheet = workbook.getWorksheet('Runs') || workbook.addWorksheet('Runs');
  if (worksheet.rowCount === 0 || !worksheet.getCell('A1').value) worksheet.addRow([]);

  const headerRow = worksheet.getRow(1);
  HEADERS.forEach((header, index) => {
    headerRow.getCell(index + 1).value = header;
  });
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  worksheet.views = [{ state: 'frozen', ySplit: 1 }];
  worksheet.autoFilter = {
    from: 'A1',
    to: `${String.fromCharCode(64 + HEADERS.length)}1`
  };
  worksheet.columns = [
    { width: 24 },
    { width: 22 },
    { width: 18 },
    { width: 28 },
    { width: 18 },
    { width: 16 },
    { width: 18 },
    { width: 38 },
    { width: 18 },
    { width: 46 },
    { width: 46 },
    { width: 16 },
    { width: 18 },
    { width: 18 },
    { width: 18 },
    { width: 70 },
    { width: 34 },
    { width: 24 }
  ];
  return worksheet;
}

function translationCounts(translations) {
  const fields = Object.values(translations || {});
  return {
    database: fields.filter((field) => field?.status === 'database').length,
    fallback: fields.filter((field) => field?.status !== 'database' && field?.status !== 'empty').length
  };
}

function translationModelSummary(translations) {
  const fields = Object.values(translations || {});
  const modelCounts = new Map();
  let escalations = 0;

  for (const field of fields) {
    const model = field?.source?.model;
    if (!model) continue;
    modelCounts.set(model, (modelCounts.get(model) || 0) + 1);
    if (field?.source?.modelEscalated) escalations += 1;
  }

  return {
    models: Array.from(modelCounts.entries()).map(([model, count]) => `${model}: ${count}`).join(', '),
    escalations
  };
}

export async function appendRunLog({ run, config, sharePointClient }) {
  const localRunLog = path.join(config.tmpRoot, 'run-log', 'label-agent-runs.xlsx');
  await fs.mkdir(path.dirname(localRunLog), { recursive: true });

  if (sharePointClient?.enabled && config.sharePoint.paths.runLog) {
    try {
      await sharePointClient.downloadToFile(config.sharePoint.paths.runLog, localRunLog);
    } catch (error) {
      if (!String(error.message).includes('404')) throw error;
    }
  }

  const workbook = new ExcelJS.Workbook();
  if (await fileExists(localRunLog)) {
    try {
      await workbook.xlsx.readFile(localRunLog);
    } catch {
      workbook.addWorksheet('Runs');
    }
  } else {
    workbook.addWorksheet('Runs');
  }

  const worksheet = setupWorksheet(workbook);
  const counts = translationCounts(run.translations);
  const modelSummary = translationModelSummary(run.translations);
  worksheet.addRow([
    run.runId,
    run.timestamp,
    run.source?.kind || '',
    run.source?.emailSubject || '',
    run.spec?.articleNumber || '',
    run.spec?.supplierNumber || '',
    run.spec?.brand || '',
    run.spec?.legalProduct || '',
    run.spec?.templateType || '',
    run.sharePointInputPath || '',
    run.sharePointOutputPath || '',
    run.reviewRequired ? 'YES' : 'NO',
    run.reviewItems?.length || 0,
    counts.database,
    counts.fallback,
    JSON.stringify([...(run.spec?.qaWarnings || []), ...(run.reviewItems || [])]),
    modelSummary.models,
    modelSummary.escalations
  ]);

  const lastRow = worksheet.lastRow;
  lastRow.alignment = { vertical: 'top', wrapText: true };
  if (run.reviewRequired) {
    lastRow.getCell(11).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFC7CE' } };
  }

  let writtenRunLog = localRunLog;
  try {
    await workbook.xlsx.writeFile(localRunLog);
  } catch (error) {
    if (!['EBUSY', 'EPERM'].includes(error.code)) throw error;
    writtenRunLog = path.join(config.tmpRoot, 'run-log', `label-agent-runs-pending-${run.runId}.xlsx`);
    await workbook.xlsx.writeFile(writtenRunLog);
  }

  if (sharePointClient?.enabled && config.sharePoint.paths.runLog) {
    await sharePointClient.uploadFile(
      writtenRunLog,
      config.sharePoint.paths.runLog,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
  }

  return writtenRunLog;
}
