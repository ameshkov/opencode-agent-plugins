import { configDefaults, defineConfig } from 'vitest/config';

/**
 * Main test config, used by `pnpm test` / `pnpm check`.
 *
 * Excludes the binary-dependent e2e tests (`*.e2e.test.ts`) so the CI gate
 * never requires the `opencode` binary. The e2e suite (if and when added)
 * runs under its own `vitest.test-e2e.config.ts`.
 */
export default defineConfig({
  test: {
    globals: true,
    exclude: [...configDefaults.exclude, 'test-e2e/**/*.e2e.test.ts'],
  },
});
