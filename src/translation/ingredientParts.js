// Splits an ingredient declaration into the ingredients it is actually made of.

/**
 * A declaration is a list of ingredients, and an ingredient stays one unit even
 * when it is several words. "mango jam" is a single ingredient that Dutch writes
 * as one word ("mangojam"), so looking up "mango" and "jam" separately produces
 * something no reader would write. Every lookup — database first, AI second —
 * therefore gets a whole ingredient name, never a loose word from inside one.
 *
 * Percentages and E-numbers are carried along untouched. They belong to the
 * ingredient and must stay exactly where they are, but they read the same in all
 * 13 languages, so neither the database nor the AI should ever see them:
 * "mango jam 12%" is looked up as "mango jam", and the " 12%" rides along.
 *
 * The output alternates two kinds of part:
 *   text  — an ingredient name, to be translated
 *   fixed — separators, percentages, E-numbers; reproduced verbatim
 *
 * Concatenating every part in order reproduces the input exactly, which is what
 * lets a translated declaration keep the structure of the original.
 */

/** Punctuation that ends an ingredient. A period only counts at the end. */
const HARD = /[,;:()[\]{}/|]+|\.(?=\s|$)/;

/**
 * Quantities: percentages, E-numbers, bare numbers.
 *
 * Fenced off from letters, apostrophes and hyphens on both sides, which is what
 * keeps a digit that belongs to a name attached to it: "Disodium
 * 5'Ribonucleotides" is one ingredient, not "Disodium" plus a stray 5.
 */
const NUM = /(?<![\p{L}\p{N}'\u2019-])(?:\d+(?:[.,]\d+)?\s*%|E\s*\d+[a-z]?|\d+(?:[.,]\d+)?)(?![\p{L}'\u2019-])/u;

const WS = /\s+/;
const WORD = /[^\s,;:()[\]{}/|]+/;

/** One sticky pass, so the lookarounds in NUM see real surrounding context. */
const TOKEN = new RegExp(
  `(?<hard>${HARD.source})|(?<num>${NUM.source})|(?<ws>${WS.source})|(?<word>${WORD.source})`,
  'yiu'
);

const HAS_LETTER = /\p{L}/u;

function tokenize(text) {
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    // Nothing matched here: keep the character as fixed rather than dropping it,
    // so the parts still reproduce the input.
    if (!match) {
      tokens.push({ kind: 'other', start: index, end: index + 1 });
      index += 1;
      continue;
    }

    const kind = Object.keys(match.groups).find((name) => match.groups[name] !== undefined);
    tokens.push({ kind, start: match.index, end: match.index + match[0].length });
    index = match.index + match[0].length;
  }

  return tokens;
}

/** A token that can be part of an ingredient name: a word containing a letter. */
function isNamePart(text, token) {
  return token.kind === 'word' && HAS_LETTER.test(text.slice(token.start, token.end));
}

export function parseIngredientParts(sourceText) {
  const text = String(sourceText || '');
  const tokens = tokenize(text);
  const parts = [];
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index];

    if (isNamePart(text, token)) {
      let end = token.end;
      let next = index + 1;

      // A name runs on across single spaces, so "hydrolysed OATS flour" stays
      // one ingredient instead of three separate lookups.
      while (
        next + 1 < tokens.length &&
        tokens[next].kind === 'ws' &&
        isNamePart(text, tokens[next + 1])
      ) {
        end = tokens[next + 1].end;
        next += 2;
      }

      parts.push({ kind: 'text', text: text.slice(token.start, end), start: token.start, end });
      index = next;
      continue;
    }

    let end = token.end;
    let next = index + 1;
    while (next < tokens.length && !isNamePart(text, tokens[next])) {
      end = tokens[next].end;
      next += 1;
    }

    parts.push({ kind: 'fixed', text: text.slice(token.start, end), start: token.start, end });
    index = next;
  }

  return parts;
}

/** The ingredient names in a declaration, in order, without duplicates. */
export function ingredientNames(sourceText) {
  const seen = new Set();
  const names = [];

  for (const part of parseIngredientParts(sourceText)) {
    if (part.kind !== 'text') continue;
    const name = part.text.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}
