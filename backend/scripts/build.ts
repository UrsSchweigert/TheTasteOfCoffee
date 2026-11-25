// Bundles every handler in src/handlers/ into dist/<name>/index.mjs for the
// Lambda nodejs22.x runtime on arm64: one self-contained ESM file per handler,
// minified, with a source map. The architecture is set on the function in
// infra/; the bundle itself is plain JavaScript.
import { readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { build } from 'esbuild';
import { BACKEND_DIR } from './codegen/paths.ts';

const handlersDir = join(BACKEND_DIR, 'src', 'handlers');
const distDir = join(BACKEND_DIR, 'dist');

const entries = readdirSync(handlersDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .sort();

rmSync(distDir, { recursive: true, force: true });

for (const file of entries) {
  const name = basename(file, '.ts');
  await build({
    entryPoints: [join(handlersDir, file)],
    outfile: join(distDir, name, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: true,
    legalComments: 'none',
    // The AWS SDK v3 ships with the runtime; keep it out of the bundle once used.
    external: ['@aws-sdk/*'],
    logLevel: 'warning',
  });
  console.log(`build: dist/${name}/index.mjs`);
}
