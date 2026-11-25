// Writes src/generated/contract.ts from contracts/openapi.yaml.
// With --check, generates into a temporary directory instead and exits 1 if
// the committed file differs (no drift between contract and backend).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { BACKEND_DIR, GENERATED_FILE, generateFromContract } from './codegen/paths.ts';

const check = process.argv.includes('--check');
const source = generateFromContract();
const target = relative(BACKEND_DIR, GENERATED_FILE);

if (check) {
  const dir = mkdtempSync(join(tmpdir(), 'cupmark-contract-'));
  try {
    const fresh = join(dir, 'contract.ts');
    writeFileSync(fresh, source);
    let committed = '';
    try {
      committed = readFileSync(GENERATED_FILE, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      console.error(`check:generated: ${target} is missing. Run \`npm run generate\`.`);
      process.exit(1);
    }
    if (committed !== readFileSync(fresh, 'utf8')) {
      console.error(`check:generated: ${target} is out of date with contracts/openapi.yaml. Run \`npm run generate\` and commit the result.`);
      process.exit(1);
    }
    console.log(`check:generated: ${target} is up to date`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
} else {
  writeFileSync(GENERATED_FILE, source);
  console.log(`generate: wrote ${target}`);
}
