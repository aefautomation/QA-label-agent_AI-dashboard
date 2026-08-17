// Single source of truth for language codes.
//
// This agent and the DOCX templates use historical codes where SE/DK/CZ are
// country codes rather than language codes. The AEF AI Platform database stores
// ISO 639-1 only, so every crossing of that boundary goes through these maps.
import { LANGUAGES } from '../config.js';

/** Agent/template code -> ISO 639-1. */
export const AGENT_TO_ISO = {
  EN: 'en',
  DE: 'de',
  NL: 'nl',
  FR: 'fr',
  SE: 'sv', // Zweeds
  FI: 'fi',
  DK: 'da', // Deens
  IT: 'it',
  CZ: 'cs', // Tsjechisch
  HU: 'hu',
  PL: 'pl',
  ES: 'es',
  SK: 'sk'
};

/** ISO 639-1 -> agent/template code. */
export const ISO_TO_AGENT = Object.fromEntries(
  Object.entries(AGENT_TO_ISO).map(([agent, iso]) => [iso, agent])
);

const ISO_LABELS = {
  en: 'Engels',
  de: 'Duits',
  nl: 'Nederlands',
  fr: 'Frans',
  sv: 'Zweeds',
  fi: 'Fins',
  da: 'Deens',
  it: 'Italiaans',
  cs: 'Tsjechisch',
  hu: 'Hongaars',
  pl: 'Pools',
  es: 'Spaans',
  sk: 'Slowaaks',
  no: 'Noors'
};

export function isoLanguageLabel(iso) {
  return ISO_LABELS[String(iso ?? '').toLowerCase()] ?? String(iso ?? '').toUpperCase();
}

/** The label languages, as ISO codes, in template order. */
export function labelIsoLanguages() {
  return LANGUAGES.map((language) => AGENT_TO_ISO[language.code]).filter(Boolean);
}
