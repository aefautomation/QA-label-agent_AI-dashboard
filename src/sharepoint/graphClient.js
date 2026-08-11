import fs from 'node:fs/promises';
import path from 'node:path';

const GRAPH_ROOT = 'https://graph.microsoft.com/v1.0';

function trimSlashes(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function encodeSharePointPath(value) {
  return trimSlashes(value)
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

export class SharePointClient {
  constructor(config) {
    this.config = config;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.driveId = config.driveId || '';
    this.channelFilesFolder = null;
  }

  get enabled() {
    return Boolean(
      this.config.tenantId &&
      this.config.clientId &&
      this.config.clientSecret &&
      (this.config.siteId || (this.config.teams?.teamId && this.config.teams?.channelId))
    );
  }

  get usesTeamsChannelFolder() {
    return Boolean(this.config.teams?.teamId && this.config.teams?.channelId);
  }

  async accessToken() {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    const url = `https://login.microsoftonline.com/${encodeURIComponent(this.config.tenantId)}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials'
    });

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(`Microsoft Graph token aanvraag mislukt (${response.status}): ${json.error_description || json.error || response.statusText}`);
    }

    this.token = json.access_token;
    this.tokenExpiresAt = Date.now() + Number(json.expires_in || 3600) * 1000;
    return this.token;
  }

  async request(endpoint, options = {}) {
    if (!this.enabled) throw new Error('SharePoint is niet geconfigureerd.');
    const token = await this.accessToken();
    const response = await fetch(`${GRAPH_ROOT}${endpoint}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {})
      }
    });

    if (options.rawResponse) return response;

    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const message = json.error?.message || response.statusText;
      const error = new Error(`Microsoft Graph request mislukt (${response.status}): ${message}`);
      error.status = response.status;
      throw error;
    }
    return json;
  }

  async getDriveId() {
    if (this.usesTeamsChannelFolder) {
      const base = await this.getChannelFilesFolder();
      return base.driveId;
    }
    if (this.driveId) return this.driveId;
    const drive = await this.request(`/sites/${encodeURIComponent(this.config.siteId)}/drive`);
    this.driveId = drive.id;
    return this.driveId;
  }

  async getChannelFilesFolder() {
    if (this.channelFilesFolder) return this.channelFilesFolder;

    const teamId = this.config.teams.teamId;
    const channelId = this.config.teams.channelId;
    const item = await this.request(`/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/filesFolder`);
    const driveId = item.parentReference?.driveId;
    if (!driveId || !item.id) {
      throw new Error('Teams filesFolder response bevatte geen driveId/itemId.');
    }

    this.channelFilesFolder = {
      driveId,
      itemId: item.id,
      name: item.name,
      webUrl: item.webUrl
    };
    this.driveId = driveId;
    return this.channelFilesFolder;
  }

  async pathEndpoint(itemPath, suffix = '') {
    const encoded = encodeSharePointPath(itemPath);
    if (this.usesTeamsChannelFolder) {
      const base = await this.getChannelFilesFolder();
      if (!encoded) return `/drives/${encodeURIComponent(base.driveId)}/items/${encodeURIComponent(base.itemId)}${suffix}`;
      return `/drives/${encodeURIComponent(base.driveId)}/items/${encodeURIComponent(base.itemId)}:/${encoded}:${suffix}`;
    }

    const driveId = await this.getDriveId();
    if (!encoded) return `/drives/${encodeURIComponent(driveId)}/root${suffix}`;
    return `/drives/${encodeURIComponent(driveId)}/root:/${encoded}:${suffix}`;
  }

  async getItem(itemPath) {
    return this.request(await this.pathEndpoint(itemPath));
  }

  async downloadBuffer(itemPath) {
    const response = await this.request(await this.pathEndpoint(itemPath, '/content'), {
      rawResponse: true
    });
    if (!response.ok) {
      throw new Error(`SharePoint download mislukt (${response.status}) voor ${itemPath}.`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async downloadToFile(itemPath, localPath) {
    const buffer = await this.downloadBuffer(itemPath);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, buffer);
    return localPath;
  }

  async ensureFolder(folderPath) {
    const cleanPath = trimSlashes(folderPath);
    if (!cleanPath) return;
    const parts = cleanPath.split('/').filter(Boolean);
    let parentPath = '';

    for (const part of parts) {
      const currentPath = parentPath ? `${parentPath}/${part}` : part;
      try {
        await this.getItem(currentPath);
      } catch (error) {
        if (error.status !== 404) throw error;
        await this.createFolder(parentPath, part);
      }
      parentPath = currentPath;
    }
  }

  async createFolder(parentPath, name) {
    const driveId = await this.getDriveId();
    const body = {
      name,
      folder: {},
      '@microsoft.graph.conflictBehavior': 'replace'
    };

    let endpoint;
    if (this.usesTeamsChannelFolder) {
      const base = await this.getChannelFilesFolder();
      const parent = parentPath ? await this.getItem(parentPath) : { id: base.itemId };
      endpoint = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(parent.id)}/children`;
    } else {
      endpoint = parentPath
        ? `/drives/${encodeURIComponent(driveId)}/root:/${encodeSharePointPath(parentPath)}:/children`
        : `/drives/${encodeURIComponent(driveId)}/root/children`;
    }

    return this.request(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
  }

  async uploadBuffer(buffer, itemPath, contentType = 'application/octet-stream') {
    const folder = path.posix.dirname(trimSlashes(itemPath));
    if (folder && folder !== '.') await this.ensureFolder(folder);

    const driveId = await this.getDriveId();
    if (this.usesTeamsChannelFolder) {
      const base = await this.getChannelFilesFolder();
      const encoded = encodeSharePointPath(itemPath);
      return this.request(`/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(base.itemId)}:/${encoded}:/content`, {
        method: 'PUT',
        headers: { 'Content-Type': contentType },
        body: buffer
      });
    }

    return this.request(await this.pathEndpoint(itemPath, '/content'), {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: buffer
    });
  }

  async uploadFile(localPath, itemPath, contentType = 'application/octet-stream') {
    const buffer = await fs.readFile(localPath);
    return this.uploadBuffer(buffer, itemPath, contentType);
  }
}
