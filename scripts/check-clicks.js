// Verifieert dat elk gemarkeerd woord in de declaratie naar een termgroep leidt.
import process from 'node:process';
import { getConfig } from '../src/config.js';
import { parseSpecification } from '../src/excel/specParser.js';
import { buildTranslationsForSpec } from '../src/labelAgent.js';
import { loadTranslationDbFromSupabase } from '../src/translation/supabaseTranslationDb.js';
import { buildPlatformLabelModel } from '../src/platform/labelModel.js';
import { normalizeText } from '../src/utils/normalize.js';

const config = getConfig();
const spec = parseSpecification(process.argv[2]);
const translationDb = await loadTranslationDbFromSupabase(config.supabase);
const translations = await buildTranslationsForSpec({ spec, translationDb, openaiConfig: config.openai });
const model = buildPlatformLabelModel({
  spec, translations,
  documents: { backend: 'test', input: {}, label: {}, report: {} },
  emailReport: { text: '', html: '' }
});

// Termgroepen zoals het platform ze indexeert.
const groups = new Map();
for (const item of model.reviewItems) {
  if (item.groupKey?.startsWith('term:') && item.sourceText) {
    groups.set(normalizeText(item.sourceText), item.groupKey);
  }
}
console.log('termgroepen: ' + groups.size);

const segments = translations.ingredients?.languageSegments ?? {};
let marked = 0, clickable = 0, noTerm = 0, dead = 0;
const deadTerms = new Set();
const tones = {};

for (const [lang, list] of Object.entries(segments)) {
  for (const seg of list ?? []) {
    const tone = seg.tone ?? (seg.red ? 'red' : '');
    if (!tone) continue;
    marked++;
    tones[tone] = (tones[tone] || 0) + 1;
    if (!seg.term) { noTerm++; continue; }
    const key = normalizeText(seg.term);
    if (groups.has(key)) clickable++;
    else { dead++; deadTerms.add(lang + ': ' + seg.term); }
  }
}

console.log('\nGEMARKEERDE SEGMENTEN over alle talen: ' + marked);
console.log('  per tint            : ' + JSON.stringify(tones));
console.log('  klikbaar (heeft groep): ' + clickable);
console.log('  bewust niet klikbaar  : ' + noTerm + '  (gat, geen term)');
console.log('  DODE KLIK             : ' + dead);
if (dead > 0) for (const t of [...deadTerms].slice(0, 10)) console.log('     ' + t);

const first = Object.values(segments)[0] ?? [];
console.log('\nEERSTE TAAL, gemarkeerde woorden op volgorde:');
for (const seg of first.filter((s) => (s.tone ?? (s.red ? 'red' : '')))) {
  const tone = seg.tone ?? 'red';
  const key = seg.term ? normalizeText(seg.term) : '';
  const status = !seg.term ? 'geen term' : groups.has(key) ? 'OK -> ' + groups.get(key) : 'DOOD';
  console.log('  [' + tone.padEnd(6) + '] ' + JSON.stringify(seg.text.slice(0, 30)).padEnd(34) + status);
}
