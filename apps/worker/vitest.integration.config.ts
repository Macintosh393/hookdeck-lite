// Integration tests for @hdl/worker: the real processors against the real Postgres and Redis from
// docker compose, delivering to the in-process mock receiver.
// See docs/TESTING.md#getting-postgres-and-redis
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// `.env.test` points at the test database and Redis index 1 and sets the integration backoff
// profile (retries take milliseconds). Variables that are already set (for example by CI) win.
const envFile = resolve(import.meta.dirname, '../../.env.test');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    // Checks that Postgres and Redis answer and applies migrations to the test database, once.
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/main.ts'],
      reporter: ['text-summary', 'html'],
    },
  },
});
