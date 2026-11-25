// Bundles every handler in src/handlers/ into dist/<name>/index.mjs for the
// Lambda nodejs22.x runtime on arm64: one self-contained ESM file per handler,
// minified, with a source map. The architecture is set on the function in
// infra/; the bundle itself is plain JavaScript.
import { readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { build } from 'esbuild';
import type { Plugin } from 'esbuild';
import { BACKEND_DIR } from './codegen/paths.ts';

const handlersDir = join(BACKEND_DIR, 'src', 'handlers');
const distDir = join(BACKEND_DIR, 'dist');

const entries = readdirSync(handlersDir)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
  .sort();

/**
 * AWS SDK packages bundled rather than taken from the runtime. The nodejs22.x
 * runtime ships the SDK v3 clients, which stay external, but it could not be
 * confirmed from the build environment that it ships
 * `@aws-sdk/s3-presigned-post` (M1-T4d), and a missing module would fail the
 * API function on every cold start. So it is bundled at the pinned version,
 * with the helpers it imports from `@aws-sdk/core` (`formatUrl`) and
 * `@smithy/*`; its `@aws-sdk/client-s3` import stays external, so it signs
 * with the same S3Client class as the rest of the function.
 */
const BUNDLED_AWS_SDK = new Set(['@aws-sdk/s3-presigned-post', '@aws-sdk/core']);

const awsSdkFromRuntime: Plugin = {
  name: 'aws-sdk-from-runtime',
  setup(builder) {
    builder.onResolve({ filter: /^@aws-sdk\// }, (args) => {
      const name = args.path.split('/').slice(0, 2).join('/');
      return BUNDLED_AWS_SDK.has(name) ? undefined : { path: args.path, external: true };
    });
  },
};

rmSync(distDir, { recursive: true, force: true });

for (const file of entries) {
  const name = basename(file, '.ts');
  const result = await build({
    entryPoints: [join(handlersDir, file)],
    outfile: join(distDir, name, 'index.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    minify: true,
    sourcemap: true,
    legalComments: 'none',
    // The AWS SDK v3 ships with the runtime: every @aws-sdk/* import stays out of the bundle except BUNDLED_AWS_SDK.
    plugins: [awsSdkFromRuntime],
    // ES module entries first. A package without an `exports` map (such as
    // @aws-sdk/s3-presigned-post) is otherwise taken from its CommonJS `main`,
    // whose require() of an external package throws "Dynamic require is not
    // supported" when the ESM bundle loads.
    mainFields: ['module', 'main'],
    metafile: true,
    logLevel: 'warning',
  });
  // Guard: an external package must only ever be imported, never required.
  for (const [input, meta] of Object.entries(result.metafile.inputs)) {
    for (const imported of meta.imports) {
      if (imported.external === true && imported.kind === 'require-call') {
        throw new Error(`build: ${input} requires the external ${imported.path}; it would fail at run time in the ESM bundle`);
      }
    }
  }
  console.log(`build: dist/${name}/index.mjs`);
}
