/**
 * Proves a marked word survives all the way to the AEF AI Platform.
 *
 * Two layers, because a break in either one makes a word unclickable:
 *   1. the segments keep their `tone` and `term` (mergeSegments once rebuilt
 *      every segment as { text, red, color } and silently dropped both);
 *   2. the platform model turns those segments into per-term review groups.
 *
 * Runs on a stub database with no OpenAI calls, so it is checkable in a second
 * instead of after a 20-minute run.
 */
import { translateIngredientsDeclaration } from '../src/translation/ingredientDeclaration.js';
import { buildPlatformLabelModel } from '../src/platform/labelModel.js';

const LANGS = ['DE', 'NL', 'FR', 'SE', 'FI', 'DK', 'IT', 'EN', 'CZ', 'HU', 'PL', 'ES', 'SK'];

function entry(english, nl) {
  return {
    english,
    translations: Object.fromEntries(LANGS.map((c) => [c, c === 'NL' ? nl : english + '-' + c]))
  };
}

const entries = [entry('OATS', 'HAVER'), entry('coconut oil', 'kokosolie'), entry('sugar', 'suiker')];
const byKey = new Map(entries.map((e) => [e.english.toLowerCase(), e]));
const translationDb = {
  lookup: () => null,
  lookupMany: (variants) =>
    (variants || []).map((v) => byKey.get(String(v).toLowerCase())).find(Boolean) ?? null,
  entryList: () => entries
};

const result = await translateIngredientsDeclaration({
  fieldName: 'Ingredientendeclaratie',
  sourceText: 'water, sugar, coconut oil, OATS flour, colours: E100.',
  translationDb,
  openaiConfig: {},
  productContext: {}
});

const segments = result.languageSegments.NL ?? [];
const checks = [];
function check(label, ok) {
  checks.push([label, ok]);
}

console.log('status:', result.status);
console.log('');
console.log('NL-SEGMENTEN');
for (const s of segments) {
  const tone = (s.tone || '-').padEnd(6);
  console.log('  ' + JSON.stringify(s.text).padEnd(26) + ' tone=' + tone + ' term=' + (s.term || '-'));
}

const green = segments.filter((s) => s.tone === 'green');
check('elk segment heeft tone + term', segments.every((s) => 'tone' in s && 'term' in s));
check('groene databasetermen apart gehouden', green.length === 3);
check('groene termen dragen hun Engelse term', green.length > 0 && green.every((s) => s.term));
check('NL toont de vertaling, niet het Engels', green.some((s) => s.text === 'HAVER'));
check('klikbare segmenten aanwezig', segments.filter((s) => s.tone && s.term).length >= 3);

const model = buildPlatformLabelModel({
  spec: { articleNumber: 'TEST-1', productName: 'Testproduct' },
  translations: { ingredients: result },
  documents: {},
  emailReport: null
});

const termFields = model.labelModel.fields.filter((f) => String(f.groupKey).startsWith('term:'));
const termGroups = [...new Set(termFields.map((f) => f.groupKey))];
const termItems = model.reviewItems.filter((i) => String(i.groupKey).startsWith('term:'));
const blocking = termFields.filter((f) => f.required);

console.log('');
console.log('PLATFORMMODEL');
console.log('  termgroepen  : ' + termGroups.length + '   ' + termGroups.join(', '));
console.log('  termvelden   : ' + termFields.length);
console.log('  reviewpunten : ' + termItems.length);
console.log('  blokkerend   : ' + blocking.length);

check('termgroepen aangemaakt', termGroups.length === 3);
check('13 talen per termgroep', termFields.length === termGroups.length * 13);
check('termen zijn reviewpunten', termItems.length > 0);
check('groene termen blokkeren niet', blocking.length === 0);

console.log('');
console.log('CONTROLES');
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? 'OK  ' : 'FOUT') + ' ' + label);
}
process.exit(bad ? 1 : 0);
