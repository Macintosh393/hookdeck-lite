// Prisma CLI configuration (migrate, generate, studio). Prisma 7 no longer reads the connection URL
// from schema.prisma and no longer loads .env by itself, so both happen here.
// The file name is what `prisma init` generates for 7.10 (resolved item U4 in docs/PLAN.md).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'prisma/config';

// The repository keeps one .env at its root. loadEnvFile never overwrites a variable that is
// already set, so CI and the integration tests can supply their own DATABASE_URL.
const envFile = resolve(import.meta.dirname, '../../.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    // `prisma migrate dev` no longer seeds automatically in Prisma 7. Run `pnpm db:seed`.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // `prisma generate` does not need a database, so a missing URL must not break it.
    url: process.env.DATABASE_URL ?? '',
  },
});
