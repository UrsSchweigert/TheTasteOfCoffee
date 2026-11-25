import { defineConfig } from 'vitest/config';

// `npm run test:integration`: the repository against DynamoDB Local. Skips with a
// message when DynamoDB Local is not reachable, unless REQUIRE_DYNAMODB_LOCAL=1.
export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // Show the skip message even though no test ran.
    silent: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
