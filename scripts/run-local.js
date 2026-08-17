// Runs one complete label job locally and reports what came out, without going
// through the HTTP server. Use it to validate a real product specification.
//
// Usage:
//   node --env-file-if-exists=.env scripts/run-local.js "<spec.xlsx>" [--no-ai]
//
// --no-ai disables the OpenAI fallback. Fields that hit the approved translation
// database still get real translations; misses are flagged for manual review
// instead of costing an API call. Useful to validate spec parsing, the database
// lookups, the DOCX fill and the Storage uploads on their own.
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { getConfig, hasSupabaseConfig, LANGUAGES } from '../src/config.js';
import { runLabelJob } from '../src/labelAgent.js';
import {
  DOCUMENT_BUCKET,
  SupabaseStorageClient
} from '../src/storage/supabaseStorage.js';

function truncate(value, length = 70) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '—';
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function heading(title) {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}

async function verifyStoredLabel(config, documents, expectations) {
  if (documents.backend !== 'supabase-storage' || !documents.label.path) return;

  const storage = new SupabaseStorageClient(config.supabase);
  const target = path.join(config.tmpRoot, 'verify', 'label.docx');

  try {
    await storage.downloadToFile(DOCUMENT_BUCKET, documents.label.path, target);
    const bytes = await fs.readFile(target);
    const zip = await JSZip.loadAsync(bytes);
    const documentXml = zip.file('word/document.xml');
    const xml = documentXml ? await documentXml.async('string') : '';
    // Strip the XML tags to see the text a reader would actually see.
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    console.log(`  teruggehaald uit Storage : ${Math.round(bytes.length / 1024)} kB`);
    console.log(`  geldige docx             : ${bytes[0] === 0x50 && bytes[1] === 0x4b}`);
    console.log(`  word/document.xml        : ${xml.length} tekens`);
    console.log(`  leesbare tekst           : ${text.length} tekens`);

    // Does what we extracted actually reach the label?
    console.log('\n  STAAT HET ECHT OP HET LABEL?');
    const haystack = text.toLowerCase();
    for (const [label, expected] of expectations) {
      const needle = String(expected ?? '').trim();
      if (!needle) {
        console.log(`    ${label.padEnd(22)}: (niets om te zoeken)`);
        continue;
      }

      // Labels are written with a decimal comma, the specification uses a dot.
      const variants = [...new Set([needle, needle.replace(/\./g, ','), needle.replace(/,/g, '.')])];
      const hit = variants.find((variant) => haystack.includes(variant.toLowerCase()));

      console.log(
        `    ${label.padEnd(22)}: ${hit ? 'JA ' : 'NEE'}  "${truncate(needle, 34)}"${
          hit && hit !== needle ? ` (als "${hit}")` : ''
        }`
      );
    }

    await fs.rm(path.dirname(target), { recursive: true, force: true });
  } catch (error) {
    console.log(`  FOUT bij verifiëren: ${error.message}`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const specPath = args.find((arg) => !arg.startsWith('--'));
  const noAi = args.includes('--no-ai');

  if (!specPath) {
    console.error('Gebruik: node scripts/run-local.js "<spec.xlsx>" [--no-ai]');
    process.exit(1);
  }

  if (noAi) process.env.OPENAI_ENABLE_FALLBACK = 'false';

  const config = getConfig();

  heading('CONFIGURATIE');
  console.log(`  spec                : ${path.basename(specPath)}`);
  console.log(`  Supabase            : ${hasSupabaseConfig(config)}`);
  console.log(`  OpenAI-key aanwezig : ${Boolean(config.openai.apiKey)}`);
  console.log(`  OpenAI-fallback aan : ${config.openai.enableFallback}`);
  console.log(`  talen               : ${LANGUAGES.length}`);

  const started = Date.now();
  const result = await runLabelJob({
    specPath,
    source: { kind: 'multipart', originalFileName: path.basename(specPath) },
    config
  });
  const seconds = ((Date.now() - started) / 1000).toFixed(1);

  heading(`RESULTAAT in ${seconds}s`);
  console.log(`  runId          : ${result.runId}`);
  console.log(`  templateType   : ${result.templateType}`);
  console.log(`  articleNumber  : ${result.articleNumber || '—'}`);
  console.log(`  legalProduct   : ${truncate(result.legalProduct)}`);
  console.log(`  reviewRequired : ${result.reviewRequired} (${result.reviewItems.length} punten)`);

  heading('GEEXTRAHEERDE SPECVELDEN');
  for (const [key, value] of Object.entries(result.extracted)) {
    // `nutrition` is an object keyed per nutrient, not a list.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Object.entries(value);
      const filled = entries.filter(([, nutrient]) => String(nutrient ?? '').trim());
      console.log(`  ${key.padEnd(20)}: ${filled.length}/${entries.length} gevuld`);
      for (const [nutrient, amount] of entries) {
        console.log(`      ${nutrient.padEnd(16)}: ${truncate(amount, 40)}`);
      }
      continue;
    }
    if (Array.isArray(value)) {
      console.log(`  ${key.padEnd(20)}: ${value.length} regels`);
      for (const row of value.slice(0, 4)) console.log(`      ${truncate(JSON.stringify(row), 66)}`);
      continue;
    }
    console.log(`  ${key.padEnd(20)}: ${truncate(value, 56)}`);
  }

  heading('DOCUMENTEN');
  console.log(`  backend : ${result.documents.backend}`);
  console.log(`  bucket  : ${result.documents.bucket || '—'}`);
  console.log(`  input   : ${result.documents.input.path || '—'}`);
  console.log(`  label   : ${result.documents.label.path || '—'}`);
  console.log(`  rapport : ${result.documents.report.path || '—'}`);
  await verifyStoredLabel(config, result.documents, [
    ['artikelnummer', result.articleNumber],
    ['legal product', result.legalProduct],
    ['merk', result.extracted.brand],
    ['EAN', result.extracted.ean],
    ['nettogewicht', result.extracted.netWeight],
    ['land van productie', result.extracted.countryOfProduction],
    ['energie (kJ)', result.extracted.nutrition?.energyKj ?? result.extracted.nutrition?.energy],
    ['zout', result.extracted.nutrition?.salt]
  ]);

  heading(`REVIEWPUNTEN (${result.reviewItems.length})`);
  for (const item of result.reviewItems) {
    console.log(`  [${String(item.status).padEnd(14)}] ${truncate(item.field, 30).padEnd(31)} ${truncate(item.reason, 58)}`);
  }

  heading('E-MAILRAPPORT (eerste regels)');
  for (const line of String(result.emailReport?.text ?? '').split('\n').slice(0, 14)) {
    console.log(`  ${line}`);
  }

  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('\nMISLUKT:', error.message);
    console.error(error.stack);
    process.exit(1);
  });
}
