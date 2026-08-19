/**
 * Proves a transient OpenAI failure no longer costs the whole declaration.
 *
 * A run once came back with 37 ingredients in red English while the OpenAI logs
 * showed every one of them correctly translated. The call had failed on the agent
 * side ("fetch failed") after OpenAI had already produced the answer, and there
 * was no retry: the agent fell back to "approved database only", so every unknown
 * ingredient stayed English. Nothing on the label said why.
 *
 * Uses a stubbed global fetch, so this runs offline and costs nothing.
 */
import { translateIngredientTermsWithOpenAi } from '../src/translation/openaiFallback.js';

const TERMS = ['Konjac Flour', 'Dried Shiitake Mushroom'];

const ANSWER = {
  termTranslations: {
    'Konjac Flour': {
      NL: 'konjacmeel',
      DE: 'Konjakmehl',
      FR: 'farine de konjac',
      EN: 'konjac flour',
      confidence: 'high',
      confidenceScore: 0.9
    },
    'Dried Shiitake Mushroom': {
      NL: 'gedroogde shiitake-paddenstoel',
      DE: 'Getrockneter Shiitake-Pilz',
      FR: 'champignon shiitake séché',
      EN: 'dried shiitake mushroom',
      confidence: 'medium',
      confidenceScore: 0.5
    }
  }
};

function okResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(ANSWER) }] }]
    })
  };
}

const config = {
  apiKey: 'test-key',
  enableFallback: true,
  enableWebSearch: false,
  model: 'gpt-5-mini',
  reviewModel: 'gpt-5',
  timeoutMs: 5000,
  maxAttempts: 3,
  // Kept short so the test stays fast; production waits 4s, 8s.
  retryDelayMs: 10
};

const checks = [];
function check(label, ok) {
  checks.push([label, ok]);
}

async function run(label, fetchStub) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchStub;
  try {
    return await translateIngredientTermsWithOpenAi({
      fieldName: 'Ingredientendeclaratie',
      sourceText: 'water, Konjac Flour, Dried Shiitake Mushroom (2,0%).',
      config,
      productContext: {},
      terminology: [],
      unmatchedTerms: TERMS
    });
  } catch (error) {
    return { failedWith: error.message };
  } finally {
    globalThis.fetch = original;
    console.log('  ' + label);
  }
}

console.log('SCENARIOS');

// 1. Exactly what happened: the socket dies once, then it works.
let calls = 0;
const afterHiccup = await run('netwerkfout op poging 1, daarna goed', async () => {
  calls += 1;
  if (calls === 1) throw new TypeError('fetch failed');
  return okResponse();
});

console.log('    aanroepen: ' + calls);
console.log('    NL Konjac Flour: ' + JSON.stringify(afterHiccup.termTranslations?.['Konjac Flour']?.translations?.NL));

check('opnieuw geprobeerd na netwerkfout', calls === 2);
check(
  'vertaling is er alsnog',
  afterHiccup.termTranslations?.['Konjac Flour']?.translations?.NL === 'konjacmeel'
);
check(
  'hoge zekerheid blijft paars-waardig',
  afterHiccup.termTranslations?.['Konjac Flour']?.confident === true
);
check(
  'medium zekerheid blijft rood',
  afterHiccup.termTranslations?.['Dried Shiitake Mushroom']?.confident === false
);
check(
  'ontbrekende taal valt terug op de bron, niet op leeg',
  afterHiccup.termTranslations?.['Konjac Flour']?.translations?.SK === 'Konjac Flour'
);

// 2. A timeout is also worth retrying.
let timeoutCalls = 0;
const afterTimeout = await run('timeout op poging 1, daarna goed', async (_url, init) => {
  timeoutCalls += 1;
  if (timeoutCalls === 1) {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    throw abort;
  }
  return okResponse();
});
console.log('    aanroepen: ' + timeoutCalls);
check('opnieuw geprobeerd na timeout', timeoutCalls === 2);
check('vertaling na timeout alsnog binnen', afterTimeout.termTranslations?.['Konjac Flour']?.translations?.DE === 'Konjakmehl');

// 3. A bad request is not worth retrying.
let badCalls = 0;
const afterBadRequest = await run('HTTP 400, niet opnieuw proberen', async () => {
  badCalls += 1;
  return {
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    json: async () => ({ error: { message: 'invalid model' } })
  };
});
console.log('    aanroepen: ' + badCalls);
check('400 niet opnieuw geprobeerd', badCalls === 1);
check('400 komt als fout naar boven', Boolean(afterBadRequest.failedWith));

// 4. A body that dies halfway must not read as "OpenAI said nothing".
let brokenCalls = 0;
await run('afgebroken body, daarna goed', async () => {
  brokenCalls += 1;
  if (brokenCalls === 1) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => {
        throw new Error('terminated');
      }
    };
  }
  return okResponse();
});
console.log('    aanroepen: ' + brokenCalls);
check('afgebroken body wordt opnieuw geprobeerd', brokenCalls === 2);

// 5. Every attempt fails: it must throw, not quietly return nothing.
let allFail = 0;
const exhausted = await run('alle pogingen falen', async () => {
  allFail += 1;
  throw new TypeError('fetch failed');
});
console.log('    aanroepen: ' + allFail);
check('pogingen begrensd op maxAttempts', allFail === 3);
check('faalt hoorbaar in plaats van stil', String(exhausted.failedWith).includes('fetch failed'));

console.log('');
console.log('CONTROLES');
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? 'OK  ' : 'FOUT') + ' ' + label);
}
process.exit(bad ? 1 : 0);
