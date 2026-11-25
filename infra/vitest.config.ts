import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Synthesising CDK apps takes a few hundred milliseconds each.
    testTimeout: 30_000,
  },
});
