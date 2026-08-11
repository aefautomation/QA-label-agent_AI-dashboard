import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from './config.js';
import { makeRunId, runLabelJob } from './labelAgent.js';

const config = getConfig();
const upload = multer({
  dest: path.join(config.tmpRoot, 'uploads'),
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 5
  }
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/outputs', express.static(config.outputRoot));

const jobs = new Map();

function requireAuth(req, res, next) {
  if (!config.webhookSecret) return next();
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  const altToken = req.get('x-label-agent-secret') || req.query.secret || req.body?.secret;
  if (token === config.webhookSecret || altToken === config.webhookSecret) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function pickSpecFile(files = []) {
  return (
    files.find((file) => file.fieldname === 'spec') ||
    files.find((file) => file.fieldname === 'specFile') ||
    files.find((file) => /\.(xlsx|xlsm)$/i.test(file.originalname)) ||
    null
  );
}

function publicDownloadUrl(filePath) {
  if (!config.publicBaseUrl || !filePath) return '';
  const relative = path.relative(config.outputRoot, filePath).replace(/\\/g, '/');
  return `${config.publicBaseUrl.replace(/\/+$/g, '')}/outputs/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

function publicEndpoint(pathname) {
  if (!config.publicBaseUrl) return pathname;
  return `${config.publicBaseUrl.replace(/\/+$/g, '')}${pathname}`;
}

function responseResult(result) {
  return {
    ...result,
    downloadUrl: publicDownloadUrl(result.outputPath),
    reportDownloadUrl: publicDownloadUrl(result.reportPath)
  };
}

function isAsyncRequest(req) {
  const value = req.query.async ?? req.body?.async ?? req.body?.responseMode;
  return ['1', 'true', 'yes', 'ja', 'async'].includes(String(value || '').toLowerCase());
}

async function writeJobState(job) {
  const jobDir = path.join(config.outputRoot, 'jobs');
  await fs.mkdir(jobDir, { recursive: true });
  await fs.writeFile(path.join(jobDir, `${job.runId}.json`), JSON.stringify(job, null, 2), 'utf8');
}

async function persistJobState(job) {
  try {
    await writeJobState(job);
  } catch (error) {
    console.error('Job-status opslaan mislukt:', error);
  }
}

async function readJobState(runId) {
  const cached = jobs.get(runId);
  if (cached) return cached;

  try {
    const filePath = path.join(config.outputRoot, 'jobs', `${runId}.json`);
    const job = JSON.parse(await fs.readFile(filePath, 'utf8'));
    jobs.set(runId, job);
    return job;
  } catch {
    return null;
  }
}

function startAsyncLabelJob({ runId, jobArgs }) {
  const job = {
    runId,
    status: 'processing',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: '',
    failedAt: '',
    error: '',
    result: null
  };

  jobs.set(runId, job);
  void persistJobState(job);

  runLabelJob({ ...jobArgs, runId })
    .then(async (result) => {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.result = responseResult(result);
      jobs.set(runId, job);
      await persistJobState(job);
    })
    .catch(async (error) => {
      console.error(error);
      job.status = 'failed';
      job.failedAt = new Date().toISOString();
      job.error = error.message || 'Onbekende fout';
      jobs.set(runId, job);
      await persistJobState(job);
    });
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'label-agent',
    time: new Date().toISOString(),
    sharePointConfigured: Boolean(config.sharePoint.tenantId && config.sharePoint.clientId && config.sharePoint.clientSecret && (config.sharePoint.siteId || (config.sharePoint.teams.teamId && config.sharePoint.teams.channelId))),
    teamsChannelFolderConfigured: Boolean(config.sharePoint.teams.teamId && config.sharePoint.teams.channelId)
  });
});

app.get('/labels/:runId', requireAuth, async (req, res) => {
  const job = await readJobState(req.params.runId);
  if (!job) {
    return res.status(404).json({
      status: 'not_found',
      runId: req.params.runId,
      error: 'Run niet gevonden. Mogelijk is de Railway container herstart voordat de job klaar was.'
    });
  }

  if (job.status === 'completed') {
    return res.json({
      status: job.status,
      runId: job.runId,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      ...job.result
    });
  }

  return res.status(job.status === 'failed' ? 500 : 202).json({
    status: job.status,
    runId: job.runId,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    failedAt: job.failedAt,
    error: job.error,
    pollAfterSeconds: 20,
    statusUrl: publicEndpoint(`/labels/${job.runId}`)
  });
});

app.post('/labels', requireAuth, upload.any(), async (req, res, next) => {
  try {
    await fs.mkdir(config.tmpRoot, { recursive: true });
    const specFile = pickSpecFile(req.files);
    const sharePointSpecPath = req.body.sharePointSpecPath || req.body.specSharePointPath || '';
    const source = {
      kind: sharePointSpecPath ? 'sharepoint' : 'multipart',
      originalFileName: specFile?.originalname || '',
      emailSubject: req.body.emailSubject || req.body.subject || '',
      makeScenarioId: req.body.scenarioId || ''
    };
    const jobArgs = {
      specPath: specFile?.path,
      sharePointSpecPath,
      source,
      config
    };

    if (isAsyncRequest(req)) {
      const runId = makeRunId();
      startAsyncLabelJob({ runId, jobArgs });
      return res.status(202).json({
        status: 'processing',
        runId,
        pollAfterSeconds: 20,
        statusUrl: publicEndpoint(`/labels/${runId}`)
      });
    }

    const result = await runLabelJob({
      ...jobArgs
    });

    if (req.query.response === 'docx') {
      return res.download(result.outputPath);
    }

    return res.json(responseResult(result));
  } catch (error) {
    return next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.status || 500).json({
    error: error.message || 'Onbekende fout'
  });
});

app.listen(config.port, '0.0.0.0', () => {
  console.log(`Label Agent luistert op 0.0.0.0:${config.port}`);
});
