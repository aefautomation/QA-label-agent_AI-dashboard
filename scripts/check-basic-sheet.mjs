/**
 * Proves a spec is read even when the supplier named the tab differently.
 *
 * The parser used to ask for the literal string "2. BASIC". A workbook with
 * "BASIC" or "2 BASIC" then failed the entire run — sheetRows threw, no label was
 * produced — while the sheet the parser wanted was sitting right there.
 *
 * Builds real workbooks on disk and runs the real parser, so this covers the
 * resolution order too: the intended tab has to keep winning when more than one
 * name contains the word.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import xlsx from 'xlsx';
import { parseSpecification } from '../src/excel/specParser.js';

const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'basic-sheet-'));

/** A sheet with just enough on it to recognise which tab was read. */
function sheet(marker) {
  return xlsx.utils.aoa_to_sheet([
    ['Legal product name', marker],
    ['Ingredients declaration', 'water, sugar.']
  ]);
}

async function specFrom(sheetNames, markerOn) {
  const book = xlsx.utils.book_new();
  for (const name of sheetNames) {
    xlsx.utils.book_append_sheet(book, sheet(name === markerOn ? 'GELEZEN' : 'ANDERE'), name);
  }

  const file = path.join(workDir, sheetNames.join('_').replace(/[^a-z0-9_]/gi, '') + '.xlsx');
  xlsx.writeFile(book, file);

  try {
    return { spec: parseSpecification(file), error: null };
  } catch (error) {
    return { spec: null, error: error.message };
  }
}

const cases = [
  { tabs: ['1. INTRO', '2. BASIC'], expect: '2. BASIC', label: 'exacte naam' },
  { tabs: ['1. INTRO', 'BASIC'], expect: 'BASIC', label: 'alleen BASIC' },
  { tabs: ['1. INTRO', '2 BASIC'], expect: '2 BASIC', label: 'zonder punt' },
  { tabs: ['1. INTRO', 'basic'], expect: 'basic', label: 'kleine letters' },
  { tabs: ['1. INTRO', '2. Basic Data'], expect: '2. Basic Data', label: 'met extra woord' },
  // Both contain "basic"; the exact tab must still win.
  { tabs: ['2. BASIC', '9. BASIC ARCHIVE'], expect: '2. BASIC', label: 'exact wint van bevat' },
  // A bare "BASIC" outranks a longer name that merely contains it.
  { tabs: ['9. BASIC ARCHIVE', 'BASIC'], expect: 'BASIC', label: 'kale naam wint van bevat' },
  { tabs: ['1. INTRO', '3. LOGISTICS'], expect: null, label: 'geen BASIC-tab' }
];

const checks = [];
console.log('WERKBLADEN');

for (const testCase of cases) {
  const { spec, error } = await specFrom(testCase.tabs, testCase.expect);

  if (testCase.expect === null) {
    const explains = Boolean(error) && error.includes('1. INTRO') && error.includes('3. LOGISTICS');
    console.log('  ' + testCase.label.padEnd(26) + (error ? 'fout: ' + error.slice(0, 60) : 'GEEN FOUT'));
    checks.push(['ontbrekende tab geeft een fout', Boolean(error)]);
    checks.push(['de fout noemt de aanwezige tabs', explains]);
    continue;
  }

  const read = spec?.legalProduct === 'GELEZEN';
  console.log(
    '  ' + testCase.label.padEnd(26) + JSON.stringify(testCase.tabs) +
      ' -> ' + (error ? 'FOUT: ' + error.slice(0, 40) : spec?.legalProduct)
  );
  checks.push([testCase.label + ' leest de juiste tab', read]);
}

console.log('');
console.log('CONTROLES');
let bad = 0;
for (const [label, ok] of checks) {
  if (!ok) bad++;
  console.log('  ' + (ok ? 'OK  ' : 'FOUT') + ' ' + label);
}

await fs.rm(workDir, { recursive: true, force: true });
process.exit(bad ? 1 : 0);
