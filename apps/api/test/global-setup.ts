// Runs once before the api's integration tests: checks that Postgres and Redis answer, then
// applies the migrations to the test database. See docs/TESTING.md#getting-postgres-and-redis
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { createApiProducerConnection, createLogger, waitForRedisReady } from '@hdl/core';
import { createPrismaClient } from '@hdl/database';

const NOT_REACHABLE = 'Postgres/Redis not reachable. Run: docker compose up -d postgres redis';

export default async function setup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl)
    throw new Error('DATABASE_URL and REDIS_URL must be set (.env.test)');

  const prisma = createPrismaClient(databaseUrl);
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    throw new Error(NOT_REACHABLE);
  } finally {
    await prisma.$disconnect();
  }

  const redis = createApiProducerConnection(
    redisUrl,
    createLogger({ level: 'silent', name: 'setup' }),
  );
  const redisReady = await waitForRedisReady(redis, 3000);
  redis.disconnect();
  if (!redisReady) throw new Error(NOT_REACHABLE);

  // `migrate deploy` applies pending migrations and never prompts. It reads DATABASE_URL from
  // the environment, which .env.test has pointed at hookdeck_test.
  execSync('pnpm --filter @hdl/database exec prisma migrate deploy', {
    cwd: resolve(import.meta.dirname, '../../..'),
    env: process.env,
    stdio: 'pipe',
  });
}
