import { defineConfig } from 'vitest/config';

/**
 * Config for the docker e2e suite (`pnpm test:e2e`).
 *
 * These tests boot a real opencode inside a container via testcontainers and
 * are excluded from the main vitest config (the e2e glob), so `pnpm test` /
 * `pnpm check` never require Docker or network.
 *
 * `globalSetup` builds the shared image exactly once per run;
 * `fileParallelism: false` is mandatory — every scenario publishes the same
 * ports (4096/3999), so test files must run one at a time.
 */
export default defineConfig({
  test: {
    include: ['test-e2e/**/*.e2e.test.ts'],
    globalSetup: ['./test-e2e/global-setup.ts'],
    fileParallelism: false,
    // opencode runs + image builds are slow; be generous.
    testTimeout: 10 * 60 * 1000,
    hookTimeout: 20 * 60 * 1000,
    sequence: { concurrent: false },
  },
});
