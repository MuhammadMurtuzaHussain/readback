import { mkdirSync, writeFileSync } from 'node:fs';
import { scanFolder } from '../src/cli/scan';
import { analyse } from '../src/engine';

// The public demo only ever uses the fictional example in this repository.
const scan = await scanFolder('examples/lunchbox');
const report = analyse(scan.files, { name: 'lunchbox', allPaths: scan.allPaths });
mkdirSync('public/demo', { recursive: true });
writeFileSync('public/demo/lunchbox.json', JSON.stringify(report));
console.log(`lunchbox: ${report.journeys.length} journeys, ${report.risks.length} risks, ${report.questions.length} questions`);
