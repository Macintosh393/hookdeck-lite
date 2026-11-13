// Unit tests for @hdl/core: pure functions, no Redis. Integration tests (*.int.test.ts) have their
// own config, vitest.integration.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
});
