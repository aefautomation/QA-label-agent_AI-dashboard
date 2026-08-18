// Shows what the QA review panel will look like for one specification, without
// writing anything to Supabase.
//
// Usage: node --env-file-if-exists=.env scripts/preview-review-panel.js "<spec.xlsx>" [--no-ai]
//
// Prints the review items the way the platform groups them: sections, then one
// group per declaration with its languages, plus the terms flagged as uncertain.
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { getConfig, hasSupabaseConfig } from '../src/config.js';
import { parseSpecification } from '../src/excel/specParser.js';
import { buildTranslationsForSpec } from '../src/labelAgent.js';
import { loadTranslationDbFromSupabase } from '../src/translation/supabaseTranslationDb.js';
import { buildPlatformLabelModel } from '../src/platform/labelModel.js';

function truncate(value, length = 66) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '—';
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

/** Same rule as lib/label-agent/grouping.ts on the platform side. */
function groupItems(items) {
  const groups = new Map();
  const loose = [];

  for (const item of items) {
    const key = item.groupKey ?? null;
    if (!key) {
      loose.push(item);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }

  for (const [key, list] of [...groups.entries()]) {
    if (list.length === 1) {
      loose.push(list[0]);
      groups.delete(key);
    }
  }

  return { groups, loose };
}

function uncertainTerms(segments) {
  if (!Array.isArray(segments)) return [];
  const seen = new Set();
  for (const segment of segments) {
    const term = segment.text?.trim();
    if (!segment.red || !term || !/[\p{Letter}\p{Number}]/u.test(term)) continue;
    seen.add(term);
  }
  return [...seen];
}

async function main() {
  const args = process.argv.slice(2);
  const specPath = args.find((arg) => !arg.startsWith('--'));
  if (args.includes('--no-ai')) process.env.OPENAI_ENABLE_FALLBACK = 'false';

  if (!specPath) {
    console.error('Gebruik: node scripts/preview-review-panel.js "<spec.xlsx>" [--no-ai]');
    process.exit(1);
  }

  const config = getConfig();
  if (!hasSupabaseConfig(config)) throw new Error('Supabase is niet geconfigureerd.');

  const spec = parseSpecification(specPath);
  const translationDb = await loadTranslationDbFromSupabase(config.supabase);
  const translations = await buildTranslationsForSpec({
    spec,
    translationDb,
    openaiConfig: config.openai
  });

  const model = buildPlatformLabelModel({
    spec,
    translations,
    documents: { backend: 'preview', input: {}, label: {}, report: {} },
    emailReport: { text: '', html: '' }
  });

  console.log(`\nspec          : ${specPath.split(/[\\/]/).pop()}`);
  console.log(`sjabloon      : ${spec.templateType}`);
  console.log(`velden        : ${model.labelModel.fields.length}`);
  console.log(`reviewpunten  : ${model.reviewItems.length}`);
  console.log(`verplicht     : ${model.reviewItems.filter((item) => item.required).length}`);
  const ro = model.labelModel.fields.filter((f) => f.readOnly);
  console.log(`readOnly velden: ${ro.length} (alleen tonen, niet bewerken)`);
  const declItems = model.reviewItems.filter((i) => i.groupKey === 'ingredients');
  console.log(`declaratie als reviewpunt: ${declItems.length} (moet 0 zijn)`);
  const termItems = model.reviewItems.filter((i) => String(i.groupKey).startsWith('term:'));
  console.log(`termpunten: ${termItems.length}, verplicht: ${termItems.filter(i => i.required).length}`);

  const bySection = new Map();
  for (const item of model.reviewItems) {
    if (!bySection.has(item.section)) bySection.set(item.section, []);
    bySection.get(item.section).push(item);
  }

  for (const [section, items] of bySection) {
    const { groups, loose } = groupItems(items);
    console.log(`\n${'='.repeat(74)}`);
    console.log(`SECTIE ${section}  —  ${groups.size} groep(en), ${loose.length} losse punt(en)`);

    for (const [key, list] of groups) {
      const languages = list.filter((item) => item.languageCode);
      const source = list.find((item) => !item.languageCode);
      const terms = new Set();
      for (const item of list) {
        if (!item.itemKey.startsWith('term:')) continue;
        const term = (item.sourceText ?? '').trim();
        if (term) terms.add(term);
      }

      console.log(`\n  ▸ ${source?.title ?? key}   (${list.length} punten, ${languages.length} talen)`);
      console.log(`    groupKey : ${key}`);
      console.log(`    bron     : ${truncate(source?.proposedText ?? source?.sourceText)}`);
      if (terms.size > 0) {
        console.log(`    CONTROLEER ${terms.size} TERMEN: ${[...terms].slice(0, 10).join(' · ')}`);
      }
      for (const item of languages.slice(0, 3)) {
        const flagged = uncertainTerms(item.segments);
        console.log(
          `      ${(item.languageCode || '?').padEnd(3)} [${item.colorStatus.padEnd(6)}] ${truncate(item.proposedText, 44)}${
            flagged.length ? `   ⚠ ${flagged.length}` : ''
          }`
        );
      }
      if (languages.length > 3) console.log(`      … nog ${languages.length - 3} talen`);
    }

    for (const item of loose.slice(0, 6)) {
      console.log(`\n  • ${item.title}  [${item.colorStatus}]`);
      console.log(`    ${truncate(item.proposedText)}`);
    }
    if (loose.length > 6) console.log(`\n  … nog ${loose.length - 6} losse punten`);
  }

  console.log('');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error('\nMISLUKT:', error.message);
    process.exit(1);
  });
}
