/**
 * Proves an ingredient is treated as one ingredient, all the way to the platform.
 *
 * Three things used to go wrong here, and each one made the label wrong:
 *   1. the declaration was scanned for database terms anywhere in the text, so
 *      "mango jam" was translated as "mango" plus "jam" — Dutch writes one word;
 *   2. mergeSegments rebuilt every segment as { text, red, color }, throwing away
 *      the tone and the term the platform needs to open a word;
 *   3. percentages and E-numbers were treated as translatable material.
 *
 * The stub database deliberately contains "mango", "jam" and "OATS" as separate
 * terms. Those are the entries the old scan used to cut ingredients apart with,
 * so if they turn up as matches again, this test fails.
 *
 * Runs without OpenAI, so it is checkable in a second instead of after a
 * 20-minute run.
 */
import {
  analyzeIngredientsTerminology,
  translateIngredientsDeclaration
} from '../src/translation/ingredientDeclaration.js';
import { buildPlatformLabelModel } from '../src/platform/labelModel.js';

const LANGS = ['DE', 'NL', 'FR', 'SE', 'FI', 'DK', 'IT', 'EN', 'CZ', 'HU', 'PL', 'ES', 'SK'];

function entry(english, nl) {
  return {
    english,
    translations: Object.fromEntries(
      LANGS.map((code) => [code, code === 'NL' ? nl : english + '-' + code])
    )
  };
}

const entries = [
  entry('sugar', 'suiker'),
  entry('coconut oil', 'kokosolie'),
  entry('water', 'water'),
  // The traps: single words that sit inside a longer ingredient name.
  entry('mango', 'mango'),
  entry('jam', 'jam'),
  entry('OATS', 'HAVER'),
  // A stored value that offers a choice instead of an answer, in Dutch only.
  // Every other language gets a single value, so this also checks that the
  // judgement is made per language.
  entry('flavour', 'aroma / smaak')
];

const byKey = new Map(entries.map((item) => [item.english.toLowerCase(), item]));
const translationDb = {
  lookup: () => null,
  lookupMany: (variants) =>
    (variants || []).map((variant) => byKey.get(String(variant).toLowerCase())).find(Boolean) ?? null,
  entryList: () => entries
};

// Written with a dot on purpose: the label uses a comma in every language, so
// the output must not depend on how the supplier typed the specification.
const SOURCE =
  'water, sugar, mango jam 12.5%, coconut oil, hydrolysed OATS flour, flavour, colours: E100.';

const result = await translateIngredientsDeclaration({
  fieldName: 'Ingredientendeclaratie',
  sourceText: SOURCE,
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
for (const segment of segments) {
  const tone = (segment.tone || '-').padEnd(6);
  console.log(
    '  ' + JSON.stringify(segment.text).padEnd(26) + ' tone=' + tone + ' term=' + (segment.term || '-')
  );
}

console.log('');
console.log('NAAR DE AI (' + result.source.unmatchedTerms.length + ')');
for (const term of result.source.unmatchedTerms) console.log('  ' + term);

const allText = segments.map((segment) => segment.text).join('');
const terms = segments.filter((segment) => segment.term).map((segment) => segment.term);
const green = segments.filter((segment) => segment.tone === 'green');

check('elk segment heeft tone + term', segments.every((segment) => 'tone' in segment && 'term' in segment));
check('mango jam is 1 term', terms.includes('mango jam'));
check('mango en jam niet los behandeld', !terms.includes('mango') && !terms.includes('jam'));
check('hydrolysed OATS flour is 1 term', terms.includes('hydrolysed OATS flour'));
check('OATS niet uit dat ingredient getrokken', !terms.includes('OATS'));
check('percentage staat nog in de tekst', allText.includes('12,5%'));
check('percentage zit in geen enkele term', !terms.some((term) => term.includes('%')));
check('E100 staat nog in de tekst', allText.includes('E100'));
check('E100 zit in geen enkele term', !terms.some((term) => /E\s*\d/i.test(term)));

// Decimal separator: always a comma, in all 13 languages including English.
const everyLanguage = Object.values(result.languageSegments).map((list) =>
  (list ?? []).map((segment) => segment.text).join('')
);
check(
  'decimaal is overal een komma',
  everyLanguage.every((line) => line.includes('12,5%') && !line.includes('12.5'))
);
check(
  'ook het Engels krijgt een komma',
  (result.translations.EN ?? '').includes('12,5%')
);
check('slotpunt blijft staan', everyLanguage.every((line) => line.trim().endsWith('.')));
check('databasetermen zijn groen', green.length === 3);
check('groene termen dragen hun Engelse term', green.every((segment) => segment.term));
check('NL toont de vertaling', green.some((segment) => segment.text === 'kokosolie'));

// Yellow: from the database, but the stored value is a choice, not an answer.
const yellowNl = segments.find((segment) => segment.tone === 'yellow');
const flavourDe = (result.languageSegments.DE ?? []).find((segment) => segment.term === 'flavour');
check('waarde met alternatieven is geel, niet groen', yellowNl?.term === 'flavour');
check('gele waarde toont nog wel de databasetekst', yellowNl?.text === 'aroma / smaak');
check('geel is per taal beoordeeld', flavourDe?.tone === 'green');

const analysis = analyzeIngredientsTerminology(SOURCE, translationDb);
check(
  'AI krijgt hele ingredientnamen',
  analysis.unmatchedTerms.includes('mango jam') &&
    analysis.unmatchedTerms.includes('hydrolysed OATS flour')
);
check(
  'AI krijgt geen losse woorden',
  !analysis.unmatchedTerms.some((term) => ['mango', 'jam', 'OATS'].includes(term))
);
check(
  'AI krijgt geen E-nummers of percentages',
  !analysis.unmatchedTerms.some((term) => /%|E\s*\d/i.test(term))
);

const model = buildPlatformLabelModel({
  spec: { articleNumber: 'TEST-1', productName: 'Testproduct' },
  translations: { ingredients: result },
  documents: {},
  emailReport: null
});

const termFields = model.labelModel.fields.filter((field) => String(field.groupKey).startsWith('term:'));
const termGroups = [...new Set(termFields.map((field) => field.groupKey))];
const blocking = new Set(
  termFields.filter((field) => field.required).map((field) => field.groupKey)
);

console.log('');
console.log('PLATFORMMODEL');
console.log('  termgroepen  : ' + termGroups.length);
for (const group of termGroups) {
  console.log('    ' + group + (blocking.has(group) ? '  (blokkeert)' : ''));
}
console.log('  termvelden   : ' + termFields.length);

check('elke term wordt een groep', termGroups.length === 7);
check('13 talen per termgroep', termFields.length === termGroups.length * 13);
check('mango jam is een eigen groep', termGroups.includes('term:mango-jam'));
check('groene termen blokkeren niet', !blocking.has('term:sugar') && !blocking.has('term:coconut-oil'));
check('onopgeloste termen blokkeren wel', blocking.has('term:mango-jam'));
// Yellow in one language is enough: the term cannot be signed off anywhere
// until someone has picked a variant.
check('gele term blokkeert wel', blocking.has('term:flavour'));

console.log('');
console.log('CONTROLES');
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? 'OK  ' : 'FOUT') + ' ' + label);
}
process.exit(bad ? 1 : 0);
