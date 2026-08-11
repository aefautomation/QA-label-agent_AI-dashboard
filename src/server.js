import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { getConfig } from './config.js';
import { runLabelJob } from './labelAgent.js';

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

function publicDownloadUrl(result) {
  if (!config.publicBaseUrl || !result.outputPath) return '';
  const relative = path.relative(config.outputRoot, result.outputPath).replace(/\\/g, '/');
  return `${config.publicBaseUrl.replace(/\/+$/g, '')}/outputs/${relative.split('/').map(encodeURIComponent).join('/')}`;
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

app.post('/labels', requireAuth, upload.any(), async (req, res, next) => {
  try {
    await fs.mkdir(config.tmpRoot, { recursive: true });
    const specFile = pickSpecFile(req.files);
    const sharePointSpecPath = req.body.sharePointSpecPath || req.body.specSharePointPath || '';

    const result = await runLabelJob({
      specPath: specFile?.path,
      sharePointSpecPath,
      source: {
        kind: sharePointSpecPath ? 'sharepoint' : 'multipart',
        originalFileName: specFile?.originalname || '',
        emailSubject: req.body.emailSubject || req.body.subject || '',
        makeScenarioId: req.body.scenarioId || ''
      },
      config
    });

    if (req.query.response === 'docx') {
      return res.download(result.outputPath);
    }

    return res.json({
      ...result,
      downloadUrl: publicDownloadUrl(result)
    });
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

app.listen(config.port, () => {
  console.log(`Label Agent luistert op poort ${config.port}`);
});
