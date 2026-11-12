// Integration tests for @hdl/api: the real app against the real Postgres and Redis from docker compose.
// See docs/TESTING.md#getting-postgres-and-redis
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// `.env.test` points at the test database and Redis index 1. Variables that are already set
// (for example by CI) win, because loadEnvFile never overwrites an existing variable.
const envFile = resolve(import.meta.dirname, '../../.env.test');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
