// Express API for Make/Railway: starts SharePoint-only label jobs and exposes polling status.
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env, getConfig, hasSharePointConfig, hasSupabaseConfig } from './config.js';
import { makeRunId, runLabelJob } from './labelAgent.js';

const config = getConfig();
const uploadDir = path.join(config.tmpRoot, 'uploads');
await fs.mkdir(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 50 * 1024 * 1024,
    files: 5
  }
});

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

const jobs = new Map();

/**
 * What this build can do, reported by /health.
 *
 * Without it there is no way to tell from the outside whether a deploy
 * actually landed — which cost real debugging time: a run looked broken while
 * the platform was simply talking to an older build.
 * Add an entry when the contract with the AEF AI Platform changes.
 */
const BUILD_FEATURES = [
  'supabase-storage',
  'supabase-write-back',
  'readonly-declaration',
  'segment-tone',
  'segment-term',
  'term-groups'
];

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

function publicEndpoint(pathname) {
  if (!config.publicBaseUrl) return pathname;
  return `${config.publicBaseUrl.replace(/\/+$/g, '')}${pathname}`;
}

function responseResult(result) {
  return result;
}

function isAsyncRequest(req) {
  const value = req.query.async ?? req.body?.async ?? req.body?.responseMode;
  return ['1', 'true', 'yes', 'ja', 'async'].includes(String(value || '').toLowerCase());
}

function readJobState(runId) {
  return jobs.get(runId) || null;
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

  runLabelJob({ ...jobArgs, runId })
    .then(async (result) => {
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.result = responseResult(result);
      jobs.set(runId, job);
    })
    .catch((error) => {
      console.error(error);
      job.status = 'failed';
      job.failedAt = new Date().toISOString();
      job.error = error.message || 'Onbekende fout';
      jobs.set(runId, job);
    });
}

app.get('/health', (_req, res) => {
  const supabaseConfigured = hasSupabaseConfig(config);

  res.json({
    ok: true,
    service: 'label-agent',
    time: new Date().toISOString(),
    // Which backend a run will use: Supabase wins when configured.
    storageBackend: supabaseConfigured ? 'supabase-storage' : 'sharepoint',
    // Verifiable deploy identity: compare this with the commit you pushed.
    build: {
      commit: (env('RAILWAY_GIT_COMMIT_SHA') || '').slice(0, 7) || 'unknown',
      branch: env('RAILWAY_GIT_BRANCH') || 'unknown',
      features: BUILD_FEATURES
    },
    supabaseConfigured,
    openaiConfigured: Boolean(config.openai.apiKey),
    sharePointConfigured: hasSharePointConfig(config),
    teamsChannelFolderConfigured: Boolean(config.sharePoint.teams.teamId && config.sharePoint.teams.channelId)
  });
});

app.get('/labels/:runId', requireAuth, async (req, res) => {
  const job = readJobState(req.params.runId);
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
    const specFile = pickSpecFile(req.files);
    const sharePointSpecPath = req.body.sharePointSpecPath || req.body.specSharePointPath || '';
    // The AEF AI Platform may upload the spec to Storage itself and pass the path.
    const storageSpecPath = req.body.storageSpecPath || req.body.supabaseSpecPath || '';
    const source = {
      kind: storageSpecPath ? 'storage' : sharePointSpecPath ? 'sharepoint' : 'multipart',
      originalFileName: specFile?.originalname || '',
      emailSubject: req.body.emailSubject || req.body.subject || '',
      makeScenarioId: req.body.scenarioId || '',
      // Set by the platform so the agent can write back to the right run.
      labelRunId: req.body.labelRunId || '',
      // Used when the agent has to create the label_runs row itself.
      createdBy: req.body.createdBy || req.body.requestedBy || ''
    };
    const jobArgs = {
      specPath: specFile?.path,
      sharePointSpecPath,
      storageSpecPath,
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
