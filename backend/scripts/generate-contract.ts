// Writes src/generated/contract.ts from contracts/openapi.yaml, and
// src/generated/vocabulary.ts from the published versions in
// contracts/vocabulary and the contract's x-vocabulary* tags.
// With --check, writes nothing and exits 1 if a committed file differs from a
// fresh generation (no drift between contracts and backend).
import { readFileSync, writeFileSync } from 'node:fs';
import { relative } from 'node:path';
import { BACKEND_DIR, generatedFiles } from './codegen/paths.ts';

const check = process.argv.includes('--check');
let stale = false;

for (const { file, source } of generatedFiles()) {
  const target = relative(BACKEND_DIR, file);
  if (check) {
    let committed: string | undefined;
    try {
      committed = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      committed = undefined;
    }
    if (committed === undefined) {
      console.error(`check:generated: ${target} is missing. Run \`npm run generate\`.`);
      stale = true;
    } else if (committed !== source) {
      console.error(`check:generated: ${target} is out of date with contracts/. Run \`npm run generate\` and commit the result.`);
      stale = true;
    } else {
      console.log(`check:generated: ${target} is up to date`);
    }
  } else {
    writeFileSync(file, source);
    console.log(`generate: wrote ${target}`);
  }
}

if (stale) process.exit(1);
