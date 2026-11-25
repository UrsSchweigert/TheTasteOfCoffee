import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { generateContractSource } from './zod-from-openapi.ts';

export const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OPENAPI_FILE = join(BACKEND_DIR, '..', 'contracts', 'openapi.yaml');
export const GENERATED_FILE = join(BACKEND_DIR, 'src', 'generated', 'contract.ts');

/** Parses YAML as strictly as contracts/lib/openapi.mjs does: duplicate keys throw. */
export function parseOpenApi(text: string): unknown {
  return parse(text, { uniqueKeys: true, prettyErrors: true, strict: true });
}

/** Generated source for the contract as it is on disk now. */
export function generateFromContract(): string {
  return generateContractSource(parseOpenApi(readFileSync(OPENAPI_FILE, 'utf8')));
}
