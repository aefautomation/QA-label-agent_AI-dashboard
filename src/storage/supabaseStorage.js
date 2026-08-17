// Supabase Storage client for the agent — replaces the SharePoint/Graph client.
//
// Exposes the same three operations labelAgent.js needs (download an asset to a
// local file, upload a produced file, report where it landed), so switching
// between SharePoint and Storage is a wiring change, not a rewrite.
//
// Buckets are private. The agent stores object *paths*; the AEF AI Platform
// creates short-lived signed URLs when it renders links, so no long-lived URL is
// ever persisted.
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createClient } from '@supabase/supabase-js';

export const TEMPLATE_BUCKET = process.env.SUPABASE_TEMPLATE_BUCKET || 'label-templates';
export const DOCUMENT_BUCKET = process.env.SUPABASE_DOCUMENT_BUCKET || 'label-documents';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// Which object holds which template. Version-stamped filenames are kept so a
// deployment always points at one specific approved template version; override
// these when Quality publishes a new version.
export function getTemplateObjectNames() {
  return {
    normal:
      process.env.SUPABASE_TEMPLATE_NORMAL ||
      'BI09-sjabloon-etiket-de-nl-fr-se-fi-dk-it-gb-cz-hu-pl-es-sk-versie- 040825.docx',
    frozen:
      process.env.SUPABASE_TEMPLATE_FROZEN ||
      'BI13 Sjabloon Diepvries etiket DE; NL; FR; SE; FI, DK, IT; GB; CZ; HU; PL; ES; SK versie 270125.docx',
    fisheryFrozen:
      process.env.SUPABASE_TEMPLATE_FISHERY_FROZEN ||
      'BI53 Sjabloon Diepvries Visserijproduct etiket DE; NL; FR; SE; FI, IT; GB; CZ; HU; PL; ES; SK versie 270125.docx'
  };
}

export class SupabaseStorageClient {
  constructor({ url, serviceRoleKey } = {}) {
    this.enabled = Boolean(url && serviceRoleKey);
    this.client = this.enabled
      ? createClient(url, serviceRoleKey, { auth: { persistSession: false } })
      : null;
  }

  assertEnabled() {
    if (!this.enabled) {
      throw new Error('Supabase Storage is niet geconfigureerd. Zet SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY.');
    }
  }

  /** Downloads one object to a local path and returns that path. */
  async downloadToFile(bucket, objectName, targetPath) {
    this.assertEnabled();

    const { data, error } = await this.client.storage.from(bucket).download(objectName);
    if (error) {
      throw new Error(`Kon "${objectName}" niet downloaden uit bucket "${bucket}": ${error.message}`);
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, Buffer.from(await data.arrayBuffer()));

    return targetPath;
  }

  /** Uploads a local file and returns its bucket/path. */
  async uploadFile(localPath, bucket, objectName, contentType) {
    this.assertEnabled();

    const bytes = await fs.readFile(localPath);
    const { error } = await this.client.storage.from(bucket).upload(objectName, bytes, {
      contentType: contentType || 'application/octet-stream',
      upsert: true
    });

    if (error) {
      throw new Error(`Upload van "${objectName}" naar bucket "${bucket}" mislukt: ${error.message}`);
    }

    return { bucket, path: objectName };
  }

  /**
   * Short-lived signed URL. Only used for logging/debugging; the platform signs
   * on demand when a QA employee opens a document.
   */
  async createSignedUrl(bucket, objectName, expiresInSeconds = 3600) {
    this.assertEnabled();

    const { data, error } = await this.client.storage
      .from(bucket)
      .createSignedUrl(objectName, expiresInSeconds);

    if (error) return '';
    return data?.signedUrl || '';
  }

  downloadTemplate(templateType, targetPath) {
    const objectName = getTemplateObjectNames()[templateType];

    if (!objectName) {
      throw new Error(`Onbekend sjabloontype "${templateType}".`);
    }

    return this.downloadToFile(TEMPLATE_BUCKET, objectName, targetPath).then(() => ({
      path: targetPath,
      source: 'supabase-storage',
      bucket: TEMPLATE_BUCKET,
      objectName
    }));
  }

  uploadSpec(localPath, objectName) {
    return this.uploadFile(localPath, DOCUMENT_BUCKET, objectName, XLSX_MIME);
  }

  uploadLabel(localPath, objectName) {
    return this.uploadFile(localPath, DOCUMENT_BUCKET, objectName, DOCX_MIME);
  }

  uploadReport(localPath, objectName) {
    return this.uploadFile(localPath, DOCUMENT_BUCKET, objectName, 'text/plain; charset=utf-8');
  }
}

/** Object path for one run artifact, grouped by day and run for easy browsing. */
export function documentObjectName({ kind, day, runId, fileName }) {
  return `${kind}/${day}/${runId}/${fileName}`;
}
