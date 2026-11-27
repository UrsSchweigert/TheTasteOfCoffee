import { defineConfig } from 'vitest/config';

// `npm run test:replay`: the replay and load test of the nightly rebuild
// (M3-T10). Not part of `npm test`. The script sets NODE_OPTIONS so that V8's
// old space is the Lambda memory (512 MB) and `gc` is exposed for the baseline.
export default defineConfig({
  test: {
    include: ['test/replay/**/*.test.ts'],
    environment: 'node',
    // Show the skip message of DynamoDB Local even though no test ran.
    silent: false,
    // One file at a time: the heap and time measurements must not share the machine with each other.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
