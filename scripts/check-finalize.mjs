/**
 * Proves the approved label model is laid back over the specification correctly.
 *
 * The definitive Word document is rendered from a re-parsed specification plus a
 * translations object, so every QA edit has to find its way back to the exact
 * place the template reads. A field that lands in the wrong slot does not throw
 * anything — it silently prints the agent's original value on the finished label,
 * which is the failure this guards against.
 */
import { buildApprovedInputs } from '../src/platform/approvedInputs.js';

function specFromAgent() {
  return {
    templateType: 'normal',
    articleNumber: 'DV7837-01',
    description: 'Ice Cream Mango',
    legalProduct: 'Roomijs mango',
    brand: 'AEF',
    supplierNumber: '12345',
    countryOfProduction: 'Thailand',
    logistics: { netWeight: '0.5', ean: '8712345678901' },
    storage: { directionForUse: 'Houd bevroren.', warning: 'Bevat SOJA.' },
    ingredientsDeclaration: 'water, sugar, mango jam 12%.',
    nutrition: { energyKj: '949', salt: '0.0825' },
    fish: {}
  };
}

/** A label model as the platform stores it, with QA's corrections applied. */
function approvedModel() {
  return {
    version: 1,
    fields: [
      // Corrected by QA.
      { key: 'legal_name', value: 'Roomijs mango 12%', languageCode: null, groupKey: 'legal_name' },
      { key: 'net_weight', value: '0,5 kg', languageCode: null, groupKey: null },
      { key: 'nutrition.salt', value: '0.08', languageCode: null, groupKey: null },
      // The assembled declaration, rebuilt from the approved terms by the
      // platform. This is the value that must reach the template.
      {
        key: 'translation.water-sugar-mango-jam-12.nl',
        value: 'water, suiker, mangojam 12%.',
        languageCode: 'nl',
        groupKey: 'ingredients',
        readOnly: true
      },
      {
        key: 'translation.water-sugar-mango-jam-12.en',
        value: 'water, sugar, mango jam 12%.',
        languageCode: 'en',
        groupKey: 'ingredients',
        readOnly: true
      },
      {
        key: 'translation.water-sugar-mango-jam-12.de',
        value: 'Wasser, Zucker, Mangokonfitüre 12%.',
        languageCode: 'de',
        groupKey: 'ingredients',
        readOnly: true
      },
      // A term field: its edit is already inside the declaration above, so it
      // must not be mistaken for a label field of its own.
      { key: 'term:mango-jam.nl', value: 'mangojam', languageCode: 'nl', groupKey: 'term:mango-jam' },
      // A warning translation, a different job key.
      {
        key: 'translation.bevat-soja.nl',
        value: 'Bevat SOJA.',
        languageCode: 'nl',
        groupKey: 'warning'
      },
      // Left blank by QA: must not erase what the specification said.
      { key: 'brand', value: '', languageCode: null, groupKey: null },
      { key: 'origin', value: null, languageCode: null, groupKey: null },
      // Not a label field the template knows.
      { key: 'something_else', value: 'x', languageCode: null, groupKey: null }
    ],
    nutrition: []
  };
}

const spec = specFromAgent();
const { translations, applied } = buildApprovedInputs({ spec, labelModel: approvedModel() });

console.log('TOEGEPAST: ' + JSON.stringify(applied));
console.log('');
console.log('SPEC NA OVERLAY');
console.log('  legalProduct        ' + JSON.stringify(spec.legalProduct));
console.log('  logistics.netWeight ' + JSON.stringify(spec.logistics.netWeight));
console.log('  nutrition.salt      ' + JSON.stringify(spec.nutrition.salt));
console.log('  brand (leeg gelaten) ' + JSON.stringify(spec.brand));
console.log('  countryOfProduction  ' + JSON.stringify(spec.countryOfProduction));
console.log('');
console.log('TRANSLATIONS VOOR DE TEMPLATE');
for (const [jobKey, entry] of Object.entries(translations)) {
  console.log('  ' + jobKey + ': ' + JSON.stringify(entry.translations));
  console.log('    sourceText=' + JSON.stringify(entry.sourceText) + ' reviewRequired=' + entry.reviewRequired);
}

const checks = [
  ['QA-correctie staat in de spec', spec.legalProduct === 'Roomijs mango 12%'],
  ['genest pad geraakt', spec.logistics.netWeight === '0,5 kg'],
  ['voedingswaarde geraakt', spec.nutrition.salt === '0.08'],
  ['leeg veld wist de spec niet', spec.brand === 'AEF'],
  ['null wist de spec niet', spec.countryOfProduction === 'Thailand'],
  ['EAN onaangeroerd', spec.logistics.ean === '8712345678901'],
  [
    'declaratie per taal bij de juiste job',
    translations.ingredients?.translations?.NL === 'water, suiker, mangojam 12%.' &&
      translations.ingredients?.translations?.EN === 'water, sugar, mango jam 12%.' &&
      translations.ingredients?.translations?.DE === 'Wasser, Zucker, Mangokonfitüre 12%.'
  ],
  [
    'QA-term zit in de declaratieregel',
    translations.ingredients?.translations?.NL.includes('mangojam')
  ],
  ['termveld niet als labelveld gebruikt', !('term:mango-jam' in translations)],
  ['waarschuwing bij de eigen job', translations.warning?.translations?.NL === 'Bevat SOJA.'],
  [
    'niets staat als te reviewen gemarkeerd',
    Object.values(translations).every((entry) => entry.reviewRequired === false)
  ],
  [
    'geen kleursegmenten op het definitieve label',
    Object.values(translations).every((entry) => entry.languageSegments === undefined)
  ],
  ['sourceText is de goedgekeurde Engelse regel', translations.ingredients?.sourceText === 'water, sugar, mango jam 12%.'],
  ['onbekend veld genegeerd, niet gecrasht', applied.ignored >= 3]
];

console.log('');
console.log('CONTROLES');
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? 'OK  ' : 'FOUT') + ' ' + label);
}
process.exit(bad ? 1 : 0);
