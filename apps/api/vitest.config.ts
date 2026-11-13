// Unit tests for @hdl/api (files next to the code). Integration tests live in test/ and use
// vitest.integration.config.ts.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/*.int.test.ts', '**/node_modules/**'],
  },
});
