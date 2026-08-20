/**
 * Proves each label field is translated under its own rules.
 *
 * The per-field prompt blocks are keyed on `fieldKind`. Copying them in without
 * passing that value produces exactly the behaviour they were written to fix, and
 * nothing anywhere reports it: the prompt is simply shorter. So this checks the
 * whole chain — the job says what kind of field it is, the translator forwards it,
 * and the prompt carries the matching rules and no others.
 *
 * Uses a stubbed global fetch, so it runs offline and costs nothing.
 */
import { translateField } from '../src/translation/translator.js';
import { buildPlatformLabelModel } from '../src/platform/labelModel.js';
import {
  hasTranslationOptions,
  translationOptionLanguages
} from '../src/translation/translationOptions.js';

const LANGS = ['DE', 'NL', 'FR', 'SE', 'FI', 'DK', 'IT', 'EN', 'CZ', 'HU', 'PL', 'ES', 'SK'];

/** A marker sentence from each block, enough to tell them apart in the prompt. */
const BLOCK_MARKERS = {
  preparation: 'Preparation/direction-for-use rules:',
  legalProduct: 'Legal product / product name rules:',
  warning: 'Warning text rules:',
  origin: 'Origin / country rules:',
  fishery: 'Fishery/aquaculture field rules:',
  ingredients: 'Ingredient declaration rules:'
};

const checks = [];
function check(label, ok) {
  checks.push([label, ok]);
}

function answer() {
  const translations = Object.fromEntries(LANGS.map((code) => [code, 'vertaald-' + code]));
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ ...translations, confidence: 'high', confidenceScore: 0.9 })
            }
          ]
        }
      ]
    })
  };
}

/** Runs one field through the real translator and returns the prompt it sent. */
async function promptFor(fieldKind) {
  let sent = '';
  const original = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body).input;
    return answer();
  };

  try {
    await translateField({
      fieldName: 'Testveld',
      sourceText: 'Ready to eat.',
      translationDb: { lookupMany: () => null, lookup: () => null, entryList: () => [] },
      openaiConfig: {
        apiKey: 'test',
        enableFallback: true,
        enableWebSearch: false,
        model: 'gpt-5-mini',
        timeoutMs: 5000,
        maxAttempts: 1
      },
      productContext: {},
      fieldKind
    });
  } finally {
    globalThis.fetch = original;
  }

  return sent;
}

console.log('PROMPT PER VELDSOORT');

for (const kind of ['preparation', 'legalProduct', 'warning', 'origin', 'fishery']) {
  const prompt = await promptFor(kind);
  const own = prompt.includes(BLOCK_MARKERS[kind]);
  const others = Object.entries(BLOCK_MARKERS)
    .filter(([other]) => other !== kind)
    .filter(([, marker]) => prompt.includes(marker))
    .map(([other]) => other);

  console.log(
    '  ' + kind.padEnd(13) + (own ? 'eigen blok aanwezig' : 'EIGEN BLOK ONTBREEKT') +
      (others.length ? '   ook: ' + others.join(', ') : '')
  );

  check(kind + ': eigen promptblok gaat mee', own);
  check(kind + ': geen blok van een ander veld', others.length === 0);
}

// No kind at all: the generic instructions only, as before.
const generic = await promptFor('');
check(
  'zonder veldsoort geen enkel blok',
  Object.values(BLOCK_MARKERS).every((marker) => !generic.includes(marker))
);
check('algemene instructies blijven altijd staan', generic.includes('legal'));

// --- Options in the database ------------------------------------------------
console.log('');
console.log('OPTIES IN DE DATABASE');

const optionCases = [
  ['aroma / smaak', true],
  ['arôme / saveur / goût', true],
  ['sauce de SOJA / sauce SOJA', true],
  // A slash without spaces is part of one value, not a list of choices.
  ['cream (milk/lactose)', false],
  ['E471/E472', false],
  ['kokoscrème', false],
  ['', false]
];

for (const [value, expected] of optionCases) {
  const got = hasTranslationOptions(value);
  console.log('  ' + (got === expected ? 'OK  ' : 'FOUT') + ' ' + JSON.stringify(value) + ' -> ' + got);
  check('optiedetectie: ' + JSON.stringify(value), got === expected);
}

const withOptions = {
  lookupMany: () => ({
    english: 'flavour',
    translations: { EN: 'flavour', NL: 'aroma / smaak', DE: 'Aroma' },
    source: {}
  }),
  lookup: () => null,
  entryList: () => []
};

const optionField = await translateField({
  fieldName: 'Bereidingswijze',
  sourceText: 'flavour',
  translationDb: withOptions,
  openaiConfig: {},
  productContext: {},
  fieldKind: 'preparation'
});

console.log('');
console.log('  status        : ' + optionField.status);
console.log('  reviewRequired: ' + optionField.reviewRequired);
console.log('  talen         : ' + JSON.stringify(translationOptionLanguages(optionField.translations)));

check('databasewaarde met opties krijgt eigen status', optionField.status === 'database_options');
check('databasewaarde met opties moet gereviewd worden', optionField.reviewRequired === true);
check('databasewaarde met opties is niet vertrouwd', optionField.trusted === false);
check('alleen de taal met opties wordt genoemd', optionField.notes[0]?.includes('NL'));

const model = buildPlatformLabelModel({
  spec: { articleNumber: 'A1', description: 'Test' },
  translations: { direction: optionField },
  documents: {},
  emailReport: null
});

const fields = model.labelModel.fields.filter((field) => field.groupKey === 'direction');
const filled = fields.filter((field) => field.value);
const yellow = fields.filter((field) => field.colorStatus === 'yellow');

console.log(
  '  velden        : ' + fields.length + ', gevuld ' + filled.length + ', geel ' + yellow.length
);

// Only a language that actually has a value can be yellow; a missing translation
// is red, which is a different problem and must stay visible as one.
check('elke gevulde taal wordt geel', yellow.length === filled.length && filled.length > 0);
check('een ontbrekende taal blijft rood', fields.every((field) => field.value || field.colorStatus === 'red'));
check('geel blokkeert het afronden', fields.every((field) => field.required));

// A clean database value must stay green and non-blocking.
const cleanField = await translateField({
  fieldName: 'Bereidingswijze',
  sourceText: 'flavour',
  translationDb: {
    lookupMany: () => ({ english: 'flavour', translations: { EN: 'flavour', NL: 'aroma' }, source: {} }),
    lookup: () => null,
    entryList: () => []
  },
  openaiConfig: {},
  productContext: {},
  fieldKind: 'preparation'
});

check('eenduidige databasewaarde blijft database', cleanField.status === 'database');
check('eenduidige databasewaarde blijft onbelast', cleanField.reviewRequired === false);

console.log('');
console.log('CONTROLES');
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? 'OK  ' : 'FOUT') + ' ' + label);
}
process.exit(bad ? 1 : 0);
