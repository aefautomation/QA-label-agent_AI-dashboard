// Creates the Supabase Storage buckets the agent needs and uploads the DOCX
// label templates, replacing the SharePoint template folder.
//
// Usage:
//   node scripts/setup-storage.js <template-folder> [--apply]
//
// Without --apply it only reports what it would do.
//
// Buckets (both private — the platform hands out signed URLs):
//   label-templates  the three DOCX templates, read by the agent per run
//   label-documents  input/ output/ report/ per run
//
// Templates keep their original, version-stamped filenames on purpose: pointing
// at a specific version is a feature for a legally sensitive document. The
// filename per template type is configurable through SUPABASE_TEMPLATE_*.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import {
  DOCUMENT_BUCKET,
  TEMPLATE_BUCKET,
  getTemplateObjectNames
} from '../src/storage/supabaseStorage.js';

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function client() {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error('Zet SUPABASE_URL (of NEXT_PUBLIC_SUPABASE_URL) en SUPABASE_SERVICE_ROLE_KEY.');
  }

  return createClient(url, key, { auth: { persistSession: false } });
}

async function ensureBucket(supabase, name, { apply }) {
  const { data: existing } = await supabase.storage.getBucket(name);

  if (existing) {
    console.log(`  bucket "${name}": bestaat al (public=${existing.public})`);
    return;
  }

  if (!apply) {
    console.log(`  bucket "${name}": zou worden aangemaakt (private)`);
    return;
  }

  const { error } = await supabase.storage.createBucket(name, { public: false });
  if (error) throw new Error(`Kon bucket "${name}" niet aanmaken: ${error.message}`);
  console.log(`  bucket "${name}": aangemaakt (private)`);
}

async function uploadTemplate(supabase, { templateType, objectName, localPath, apply }) {
  const stat = await fs.stat(localPath).catch(() => null);

  if (!stat) {
    console.log(`  ${templateType}: BESTAND NIET GEVONDEN — ${localPath}`);
    return false;
  }

  const sizeKb = Math.round(stat.size / 1024);

  if (!apply) {
    console.log(`  ${templateType}: zou uploaden (${sizeKb} kB) -> ${TEMPLATE_BUCKET}/${objectName}`);
    return true;
  }

  const bytes = await fs.readFile(localPath);
  const { error } = await supabase.storage.from(TEMPLATE_BUCKET).upload(objectName, bytes, {
    contentType: DOCX_MIME,
    upsert: true
  });

  if (error) throw new Error(`Upload van ${templateType} mislukt: ${error.message}`);
  console.log(`  ${templateType}: geüpload (${sizeKb} kB) -> ${TEMPLATE_BUCKET}/${objectName}`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const folder = args.find((arg) => !arg.startsWith('--'));
  const apply = args.includes('--apply');

  if (!folder) {
    console.error('Gebruik: node scripts/setup-storage.js <template-folder> [--apply]');
    process.exit(1);
  }

  const supabase = client();
  const objectNames = getTemplateObjectNames();

  console.log(`\nBUCKETS`);
  await ensureBucket(supabase, TEMPLATE_BUCKET, { apply });
  await ensureBucket(supabase, DOCUMENT_BUCKET, { apply });

  console.log(`\nSJABLONEN uit ${folder}`);
  let ok = true;
  for (const [templateType, objectName] of Object.entries(objectNames)) {
    const uploaded = await uploadTemplate(supabase, {
      templateType,
      objectName,
      localPath: path.join(folder, objectName),
      apply
    });
    ok = ok && uploaded;
  }

  if (apply) {
    console.log(`\nINHOUD van ${TEMPLATE_BUCKET}`);
    const { data, error } = await supabase.storage.from(TEMPLATE_BUCKET).list('', { limit: 50 });
    if (error) console.log(`  kon niet lijsten: ${error.message}`);
    else for (const item of data ?? []) {
      console.log(`  ${item.name} (${Math.round((item.metadata?.size ?? 0) / 1024)} kB)`);
    }
  } else {
    console.log(`\nDRY RUN — niets gewijzigd. Voeg --apply toe.`);
  }

  if (!ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
