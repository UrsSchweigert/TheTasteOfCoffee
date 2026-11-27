import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { generateAggregationFromDir } from './aggregation.ts';
import { generateExportSource } from './csv-export.ts';
import { readVocabularyDir, generateVocabularySource } from './vocabulary.ts';
import { generateContractSource } from './zod-from-openapi.ts';

export const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OPENAPI_FILE = join(BACKEND_DIR, '..', 'contracts', 'openapi.yaml');
export const VOCABULARY_DIR = join(BACKEND_DIR, '..', 'contracts', 'vocabulary');
export const GENERATED_FILE = join(BACKEND_DIR, 'src', 'generated', 'contract.ts');
export const GENERATED_VOCABULARY_FILE = join(BACKEND_DIR, 'src', 'generated', 'vocabulary.ts');
/** The aggregation contract version the backend builds against (M3-T3). A new version is a deliberate change here. */
export const AGGREGATION_DIR = join(BACKEND_DIR, '..', 'contracts', 'aggregation', 'v1');
export const GENERATED_AGGREGATION_FILE = join(BACKEND_DIR, 'src', 'generated', 'aggregation.ts');
export const GENERATED_EXPORT_FILE = join(BACKEND_DIR, 'src', 'generated', 'export.ts');

/** Parses YAML as strictly as contracts/lib/openapi.mjs does: duplicate keys throw. */
export function parseOpenApi(text: string): unknown {
  return parse(text, { uniqueKeys: true, prettyErrors: true, strict: true });
}

/** Generated source for the contract as it is on disk now. */
export function generateFromContract(): string {
  return generateContractSource(parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')));
}

/** Generated source for the published vocabulary and its bindings, as they are on disk now. */
export function generateVocabularyFromContract(): string {
  return generateVocabularySource(parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')), readVocabularyDir(VOCABULARY_DIR));
}

/** Generated source for the CSV export header and row order (x-csv-columns, x-csv-item-types), as on disk now. */
export function generateExportFromContract(): string {
  return generateExportSource(parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')));
}

/** Generated source for the reason ids and histogram buckets of contracts/aggregation/v1, as on disk now. */
export function generateAggregationFromContract(): string {
  return generateAggregationFromDir(AGGREGATION_DIR);
}

/** Every generated file and its fresh source. */
export function generatedFiles(): { file: string; source: string }[] {
  return [
    { file: GENERATED_FILE, source: generateFromContract() },
    { file: GENERATED_VOCABULARY_FILE, source: generateVocabularyFromContract() },
    { file: GENERATED_EXPORT_FILE, source: generateExportFromContract() },
    { file: GENERATED_AGGREGATION_FILE, source: generateAggregationFromContract() },
  ];
}
