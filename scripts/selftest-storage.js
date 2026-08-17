// Self-test for the Supabase backends. Run this after a deployment or an
// environment change to confirm the agent can reach everything it needs:
//   - which storage backend is active
//   - the three DOCX templates download and are intact
//   - an upload/download round-trip works and is cleaned up
//   - the approved translations load and lookups resolve
//
// Usage: node scripts/selftest-storage.js
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { getConfig, hasSharePointConfig, hasSupabaseConfig } from '../src/config.js';
import {
  DOCUMENT_BUCKET,
  SupabaseStorageClient,
  documentObjectName,
  getTemplateObjectNames
} from '../src/storage/supabaseStorage.js';
import { loadTranslationDbFromSupabase } from '../src/translation/supabaseTranslationDb.js';

async function main() {
  const config = getConfig();
  let failures = 0;

  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'OK  ' : 'FOUT'} ${label}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
  };

  console.log('CONFIGURATIE');
  const supabaseOk = hasSupabaseConfig(config);
  check('Supabase geconfigureerd', supabaseOk);
  console.log(`  info OpenAI geconfigureerd: ${Boolean(config.openai.apiKey)}`);
  console.log(`  info SharePoint geconfigureerd: ${hasSharePointConfig(config)}`);
  console.log(`  info actieve backend: ${supabaseOk ? 'supabase-storage' : 'sharepoint'}`);

  if (!supabaseOk) {
    console.log('\nSupabase ontbreekt; de rest van de test is overgeslagen.');
    process.exit(1);
  }

  const storage = new SupabaseStorageClient(config.supabase);
  const tmp = path.join(config.tmpRoot, 'selftest-storage');
  await fs.mkdir(tmp, { recursive: true });

  console.log('\nSJABLONEN uit Storage');
  for (const templateType of Object.keys(getTemplateObjectNames())) {
    const target = path.join(tmp, `${templateType}.docx`);

    try {
      await storage.downloadTemplate(templateType, target);
      const bytes = await fs.readFile(target);
      const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
      const zip = await JSZip.loadAsync(bytes);
      const documentXml = zip.file('word/document.xml');
      const xml = documentXml ? await documentXml.async('string') : '';

      check(
        templateType,
        isZip && Boolean(documentXml) && xml.length > 1000,
        `${Math.round(bytes.length / 1024)} kB, word/document.xml ${xml.length} tekens`
      );
    } catch (error) {
      check(templateType, false, error.message);
    }
  }

  console.log('\nUPLOAD ROUND-TRIP');
  const objectName = documentObjectName({
    kind: 'report',
    day: '1970-01-01',
    runId: 'selftest',
    fileName: 'probe.txt'
  });

  try {
    const localProbe = path.join(tmp, 'probe.txt');
    const content = `aef selftest ${new Date().toISOString()}`;
    await fs.writeFile(localProbe, content, 'utf8');
    await storage.uploadReport(localProbe, objectName);

    const roundTrip = path.join(tmp, 'probe-back.txt');
    await storage.downloadToFile(DOCUMENT_BUCKET, objectName, roundTrip);
    check('upload en download identiek', (await fs.readFile(roundTrip, 'utf8')) === content);

    const signed = await storage.createSignedUrl(DOCUMENT_BUCKET, objectName, 60);
    check('signed URL aangemaakt', Boolean(signed));

    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false }
    });
    const { error } = await supabase.storage.from(DOCUMENT_BUCKET).remove([objectName]);
    check('testbestand opgeruimd', !error, error?.message ?? '');
  } catch (error) {
    check('upload round-trip', false, error.message);
  }

  console.log('\nVERTALINGENDATABASE');
  try {
    const started = Date.now();
    const db = await loadTranslationDbFromSupabase({ ...config.supabase, useCache: false });
    check('termen geladen', db.entries.size > 0, `${db.entries.size} termen in ${Date.now() - started} ms`);
    check('diagnostics leeg', db.diagnostics.length === 0, db.diagnostics.join(' | '));

    for (const [probe, expectLanguage] of [
      ['sugar', 'NL'],
      ['MUSTARD', 'DE'],
      ['After defrosting use immediately', 'FR']
    ]) {
      const hit = db.lookup(probe);
      check(
        `lookup "${probe}"`,
        Boolean(hit?.translations?.[expectLanguage]),
        hit ? `${expectLanguage}="${hit.translations[expectLanguage]}"` : 'geen hit'
      );
    }
  } catch (error) {
    check('vertalingendatabase', false, error.message);
  }

  await fs.rm(tmp, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'ALLES OK' : `${failures} CONTROLE(S) GEFAALD`}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
