import { defineConfig } from 'vitest/config';

// `npm test`: unit tests only, fast and without Docker. The DynamoDB Local suite
// in test/integration/ runs with `npm run test:integration` (vitest.integration.config.ts).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/integration/**', 'test/replay/**', 'node_modules/**'],
    environment: 'node',
  },
});
