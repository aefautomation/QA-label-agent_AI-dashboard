// Shared text helpers for normalizing labels, lookup keys, XML text and filenames.
export function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function compactKey(value) {
  return normalizeText(value)
    .replace(/^ingredients:\s*/i, '')
    .replace(/\bsoybean(s)?\b/g, 'soya bean$1')
    .replace(/\bsoy\b/g, 'soya')
    .replace(/\bhydrolyzed\b/g, 'hydrolysed')
    .replace(/\bflavoring(s)?\b/g, 'flavouring$1')
    .replace(/\bflavor(s)?\b/g, 'flavour$1')
    .replace(/\bcolor(s)?\b/g, 'colour$1')
    .replace(/\bstabilizer(s)?\b/g, 'stabiliser$1')
    .replace(/[.:;]+$/g, '')
    .replace(/[^a-z0-9%<>=+\- ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Writes decimals with a comma, in every language.
 *
 * AEF standardised on the comma for all 13 languages, English included, so the
 * separator on a label no longer depends on how a supplier happened to type the
 * specification. Without this, one spec produced "2.0%" on the Dutch label and
 * another produced "2,0%" on the English one.
 *
 * Only a dot between two digits is touched, so E-numbers, sentence periods and
 * abbreviations are left alone. Thousands separators are not a concern here:
 * these specs write energy as a plain integer ("949"), never as "1.674".
 */
export function withDecimalComma(value) {
  if (value === null || value === undefined) return value;
  return String(value).replace(/(?<=\d)\.(?=\d)/g, ',');
}

export function isMeaningful(value) {
  const text = normalizeText(value);
  return Boolean(
    text &&
    text !== 'click' &&
    text !== 'click!' &&
    text !== 'double click' &&
    text !== 'double click!' &&
    !text.startsWith('(info:') &&
    !text.startsWith('info:') &&
    text !== 'n/a' &&
    text !== '-'
  );
}

export function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function safeFilePart(value) {
  return String(value ?? 'label')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 90) || 'label';
}
