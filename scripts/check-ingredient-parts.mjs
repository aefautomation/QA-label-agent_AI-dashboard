/**
 * Checks that a declaration is split into whole ingredients.
 *
 * The parser once scanned for database terms anywhere in the text, which cut
 * "mango jam" into "mango" and "jam" and found "OATS" inside "hydrolysed OATS
 * flour". Both produced translations no reader would write.
 */
import { parseIngredientParts, ingredientNames } from '../src/translation/ingredientParts.js';

const SOURCE =
  'water, sugar, mango jam 12%, coconut oil, palm oil, instant SOYA powder, maltodextrin, ' +
  'glucose syrup, sunflower oil, hydrolysed OATS flour, maltose syrup, ' +
  'stabiliser: E471; E466; E415; E407; E401, coconut milk, flavours, acidity regulators: E331, ' +
  "emulsifiers: E322 (SOYA), cocoa butter, colours: E100; E102; E129, flavour enhancers: " +
  "Monosodium Glutamate 0.95%, Disodium 5'Ribonucleotides 0.05%.";

const parts = parseIngredientParts(SOURCE);
const names = ingredientNames(SOURCE);

console.log('INGREDIENTEN (' + names.length + ')');
for (const name of names) console.log('  ' + name);

console.log('');
console.log('VASTE DELEN (gaan niet naar database of AI)');
for (const part of parts.filter((p) => p.kind === 'fixed' && /\S/.test(p.text))) {
  console.log('  ' + JSON.stringify(part.text));
}

const checks = [
  ['reproduceert de bron exact', parts.map((p) => p.text).join('') === SOURCE],
  ['mango jam blijft 1 ingredient', names.includes('mango jam')],
  ['mango en jam niet los', !names.includes('mango') && !names.includes('jam')],
  ['hydrolysed OATS flour blijft 1 ingredient', names.includes('hydrolysed OATS flour')],
  ['OATS niet los uit dat ingredient getrokken', !names.includes('OATS')],
  ['instant SOYA powder blijft 1 ingredient', names.includes('instant SOYA powder')],
  ['E-nummers zijn geen ingredient', !names.some((n) => /^E\s*\d/i.test(n))],
  ['percentages zijn geen ingredient', !names.some((n) => n.includes('%'))],
  ['stabiliser los van zijn E-nummers', names.includes('stabiliser')],
  ['SOYA uit (SOYA) blijft een eigen term', names.includes('SOYA')],
  [
    'cijfer in chemische naam blijft plakken',
    names.includes("Disodium 5'Ribonucleotides")
  ],
  ['Monosodium Glutamate zonder percentage', names.includes('Monosodium Glutamate')]
];

// --- Decimal commas ---------------------------------------------------------
//
// European specs write "2,0%" where English writes "2.0%", and the comma is also
// the separator between ingredients. So the parser has to tell "sugar 2,0%" (one
// ingredient with a quantity) from "sugar 2, salt" (a list), which it does by
// requiring a digit on both sides of the comma.
const COMMA_CASES = [
  ['mango jam (2,0%), water', ['mango jam', 'water'], [' (2,0%), ']],
  ['sugar 12,5%, salt 0,05%', ['sugar', 'salt'], [' 12,5%, ', ' 0,05%']],
  ['acid 1.5%, base 2,5%', ['acid', 'base'], [' 1.5%, ', ' 2,5%']],
  ["Disodium 5'Ribonucleotides 0,05%", ["Disodium 5'Ribonucleotides"], [' 0,05%']],
  // A bare number followed by the separator: that comma is not a decimal point,
  // because no digit follows it.
  ['salt 2, pepper', ['salt', 'pepper'], [' 2, ']]
];

console.log('');
console.log('DECIMALE KOMMA');
for (const [source, expectedNames, expectedFixed] of COMMA_CASES) {
  const gotNames = ingredientNames(source);
  const gotParts = parseIngredientParts(source);
  const gotFixed = gotParts.filter((part) => part.kind === 'fixed').map((part) => part.text);

  const namesOk = JSON.stringify(gotNames) === JSON.stringify(expectedNames);
  const fixedOk = expectedFixed.every((text) => gotFixed.includes(text));
  const exact = gotParts.map((part) => part.text).join('') === source;

  console.log('  ' + JSON.stringify(source));
  console.log('    ingredienten: ' + JSON.stringify(gotNames));
  console.log('    vast        : ' + JSON.stringify(gotFixed));
  checks.push(['komma: ' + source, namesOk && fixedOk && exact]);
}

console.log('');
console.log('CONTROLES');
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? 'OK  ' : 'FOUT') + ' ' + label);
}
process.exit(bad ? 1 : 0);
