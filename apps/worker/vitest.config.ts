// Unit tests for @hdl/worker (files next to the code): the pure helpers of the processors.
// The processors themselves are tested against the real Postgres and Redis, with
// vitest.integration.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
  },
});
