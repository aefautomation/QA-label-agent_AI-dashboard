import 'dotenv/config';
import path from 'node:path';
import { getConfig } from '../src/config.js';
import { SharePointClient } from '../src/sharepoint/graphClient.js';

const config = getConfig();
const client = new SharePointClient(config.sharePoint);

if (!client.enabled || !client.usesTeamsChannelFolder) {
  throw new Error('Zet SHAREPOINT_* credentials plus TEAMS_TEAM_ID en TEAMS_CHANNEL_ID voordat je dit script draait.');
}

const uploads = [
  {
    localPath: config.local.translationDbPath,
    remotePath: config.sharePoint.paths.translationDb,
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  },
  {
    localPath: config.local.templates.normal,
    remotePath: config.sharePoint.paths.templates.normal,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  },
  {
    localPath: config.local.templates.frozen,
    remotePath: config.sharePoint.paths.templates.frozen,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  },
  {
    localPath: config.local.templates.fisheryFrozen,
    remotePath: config.sharePoint.paths.templates.fisheryFrozen,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  }
];

await client.ensureFolder('Input');
await client.ensureFolder(config.sharePoint.paths.outputFolder);
await client.ensureFolder(path.posix.dirname(config.sharePoint.paths.runLog));

for (const upload of uploads) {
  if (!upload.localPath || !upload.remotePath) {
    console.warn(`Overgeslagen door ontbrekend pad: ${JSON.stringify(upload)}`);
    continue;
  }
  await client.uploadFile(upload.localPath, upload.remotePath, upload.contentType);
  console.log(`Geupload: ${upload.remotePath}`);
}

const folder = await client.getChannelFilesFolder();
console.log(`Teams kanaalmap: ${folder.webUrl}`);
