/**
 * Reports how much of a declaration the approved database already covers.
 *
 * Answers the question the whole design turns on: which ingredients come out
 * green today, and which still have to go to the AI. Every AI term QA approves
 * lands in the database, so running this again after a few labels should show
 * the green side growing.
 *
 * Usage:
 *   node scripts/check-coverage.mjs "water, sugar, mango jam 12%, ..."
 */
import { loadTranslationDbFromSupabase } from '../src/translation/supabaseTranslationDb.js';
import { ingredientNames, parseIngredientParts } from '../src/translation/ingredientParts.js';
import { translateIngredientsDeclaration } from '../src/translation/ingredientDeclaration.js';
import { LANGUAGES } from '../src/config.js';

const sourceText = process.argv.slice(2).join(' ').trim();
if (!sourceText) {
  console.error('Geef de ingredientendeclaratie mee als argument.');
  process.exit(2);
}

const translationDb = await loadTranslationDbFromSupabase({
  url: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY
});

// The same variants the resolver uses, so this measures the real behaviour.
function variants(term) {
  const raw = String(term || '').trim();
  return [
    raw,
    raw.replace(/\bsoy\b/gi, 'SOYA'),
    raw.replace(/\bsoybean(s)?\b/gi, 'SOYA bean$1'),
    raw.replace(/\bstabilizer(s)?\b/gi, 'stabiliser$1'),
    raw.replace(/\bcolor(s)?\b/gi, 'colour$1'),
    raw.replace(/\bflavoring(s)?\b/gi, 'flavouring$1'),
    raw.replace(/\bflavor(s)?\b/gi, 'flavour$1'),
    raw.replace(/\bhydrolyzed\b/gi, 'hydrolysed'),
    /s$/i.test(raw) && raw.length > 3 ? raw.replace(/s$/i, '') : '',
    /ies$/i.test(raw) ? raw.replace(/ies$/i, 'y') : ''
  ].filter(Boolean);
}

/** A stored value that offers a choice instead of an answer, so not trustworthy. */
function hasAlternatives(value) {
  const parts = String(value || '').split('/');
  if (parts.length < 2) return false;
  return parts.filter((part) => /\p{L}/u.test(part)).length >= 2;
}

const names = ingredientNames(sourceText);
const green = [];
const yellow = [];
const toAi = [];

for (const name of names) {
  const hit = translationDb.lookupMany(variants(name));
  if (!hit) {
    toAi.push(name);
    continue;
  }

  const missing = LANGUAGES.filter((language) => !hit.translations?.[language.code]).map(
    (language) => language.code
  );
  const choices = LANGUAGES.filter((language) => hasAlternatives(hit.translations?.[language.code])).map(
    (language) => language.code
  );
  const item = { name, databaseTerm: hit.english, missing, choices };

  if (choices.length) yellow.push(item);
  else green.push(item);
}

function describe(item) {
  const via = item.databaseTerm.toLowerCase() === item.name.toLowerCase() ? '' : '  <- ' + item.databaseTerm;
  const gaps = item.missing.length ? '  MIST: ' + item.missing.join(',') : '';
  const choices = item.choices.length ? '  KEUZE IN: ' + item.choices.join(',') : '';
  return '  ' + item.name + via + gaps + choices;
}

console.log('INGREDIENTEN: ' + names.length);
console.log('');
console.log('GROEN — database, eenduidig (' + green.length + ')');
for (const item of green) console.log(describe(item));

console.log('');
console.log('GEEL — database, maar met alternatieven; QA moet kiezen (' + yellow.length + ')');
for (const item of yellow) console.log(describe(item));

console.log('');
console.log('NAAR DE AI — nog niet in de database (' + toAi.length + ')');
for (const name of toAi) console.log('  ' + name);

const fixed = parseIngredientParts(sourceText)
  .filter((part) => part.kind === 'fixed' && /\d/.test(part.text))
  .map((part) => part.text.trim());

console.log('');
console.log('ONBEHANDELD — percentages en E-nummers (' + fixed.length + ')');
for (const part of fixed) console.log('  ' + part);

const percentage = names.length ? Math.round((green.length / names.length) * 100) : 0;
console.log('');
console.log('DEKKING: ' + green.length + '/' + names.length + ' = ' + percentage + '% groen');

// What the label reads with the database alone. The terms that still have to go
// to the AI stay in English here, which is exactly what QA will see marked red.
const rendered = await translateIngredientsDeclaration({
  fieldName: 'Ingredientendeclaratie',
  sourceText,
  translationDb,
  openaiConfig: {},
  productContext: {}
});

console.log('');
console.log('ZONDER AI OPGEBOUWD (rood = nog Engels, wacht op AI of QA)');
for (const code of ['NL', 'DE', 'FR']) {
  console.log('  ' + code + ': ' + rendered.translations[code]);
}
