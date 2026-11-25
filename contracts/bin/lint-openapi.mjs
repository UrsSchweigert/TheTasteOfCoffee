#!/usr/bin/env node
// Lints contracts/openapi.yaml: no free text, bounded numbers, closed
// objects, enums and ranges equal to the vocabulary, the bearer token on
// every route, and no field that names a user. Exit code 1 on any problem.
// Used by scripts/check-no-free-text.sh; the same checks run in `npm test`.

import { checkOpenApi, loadOpenApi, loadVocabularyContext } from '../lib/openapi.mjs';

let problems;
try {
  problems = checkOpenApi(loadOpenApi(), loadVocabularyContext());
} catch (error) {
  problems = [`cannot read openapi.yaml: ${error.message}`];
}
if (problems.length > 0) {
  console.error('openapi lint: FAILED');
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
console.log('openapi lint: ok');
