// Detects stored translations that offer a choice instead of an answer.

/**
 * The approved database holds values like "aroma / smaak" and
 * "arôme / saveur / goût". Those are alternatives nobody has picked yet, so
 * printing one on a label is wrong whichever one you take. They must not read as
 * trustworthy.
 *
 * A slash only counts when it has whitespace on both sides. Without that
 * condition "cream (milk/lactose)" and "E471/E472" would be flagged too, and
 * those are single values that happen to contain a slash.
 */
const OPTION_SEPARATOR = /\s+\/\s+/;
const HAS_OPTIONS = /\S\s+\/\s+\S/;

export function splitTranslationOptions(value) {
  const text = String(value ?? '').trim();
  if (!HAS_OPTIONS.test(text)) return [];
  return text.split(OPTION_SEPARATOR).map((option) => option.trim()).filter(Boolean);
}

/** True when this single value is a list of alternatives. */
export function hasTranslationOptions(value) {
  return splitTranslationOptions(value).length > 1;
}

/**
 * The language codes of a translation set whose value offers alternatives.
 *
 * Per language, because a term can be one word in Dutch and a choice of three in
 * French; only the French line needs a decision.
 */
export function translationOptionLanguages(translations) {
  return Object.entries(translations ?? {})
    .filter(([, value]) => hasTranslationOptions(value))
    .map(([code]) => code);
}
