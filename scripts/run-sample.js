import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLabelJob } from '../src/labelAgent.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const sampleSpecPath = process.argv[2] || 'C:\\Users\\y.caous\\Downloads\\QA proces\\7788-01 3433 20260424 Spec SEAFOOD BOWL.XLSX';

const result = await runLabelJob({
  specPath: sampleSpecPath,
  source: { kind: 'local-sample' },
  outputRoot: path.join(root, 'outputs')
});

console.log(JSON.stringify(result, null, 2));
