export const LEGAL_REFS = [
  {
    key: 'EU_1169_2011_MANDATORY',
    title: 'Regulation (EU) No 1169/2011 - mandatory food information',
    url: 'https://food.ec.europa.eu/food-safety/labelling-and-nutrition/food-information-consumers-legislation/mandatory-food-information_en'
  },
  {
    key: 'EU_1169_2011_LANGUAGE_PRESENTATION',
    title: 'Regulation (EU) No 1169/2011 - language and presentation',
    url: 'https://food.ec.europa.eu/food-safety/labelling-and-nutrition/food-information-consumers-legislation/language-and-presentation-food-information_en'
  },
  {
    key: 'EU_ALLERGENS',
    title: 'European Commission - allergen labelling overview',
    url: 'https://food.ec.europa.eu/food-safety/campaign-2026/allergies_en'
  },
  {
    key: 'EU_FISHERY_CONSUMER_INFO',
    title: 'European Commission - fishery and aquaculture commercial/scientific names',
    url: 'https://oceans-and-fisheries.ec.europa.eu/common-fisheries-policy-cfp/seafood-markets/commercial-and-scientific-name-species_en'
  },
  {
    key: 'EURLEX_1169_2011',
    title: 'EUR-Lex CELEX 32011R1169',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32011R1169'
  },
  {
    key: 'EURLEX_1379_2013',
    title: 'EUR-Lex CELEX 32013R1379',
    url: 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A32013R1379'
  }
];

export const LEGAL_TRANSLATION_INSTRUCTIONS = `
You translate EU food label text for a professional QA workflow.

Rules:
- Preserve legal meaning, ingredient order, percentages, E-numbers, dates, lot references, measurements and punctuation.
- Allergens must remain emphasised in CAPITALS where they are capitalised in the source or clearly required as allergens.
- Do not invent missing product facts.
- If a term is uncertain, provide the best legally conservative wording and explain the uncertainty in notes.
- Use the language variants in this order: DE, NL, FR, SE, FI, DK, IT, EN, CZ, HU, PL, ES, SK.
- Consider EU food information requirements, language/presentation rules, allergen requirements, and fishery/aquaculture consumer information where relevant.
`;
