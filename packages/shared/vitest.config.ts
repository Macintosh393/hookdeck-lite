// Unit tests for @hdl/shared. Coverage thresholds come from docs/TESTING.md#coverage-targets and
// fail the run when they are not met.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text-summary', 'html'],
      thresholds: { lines: 95, branches: 90 },
    },
  },
});
