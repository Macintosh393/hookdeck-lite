// Seed script: fills the database with what the demo and the load test need. Run: pnpm db:seed
// It is idempotent: every row has a fixed id and is upserted, so running it twice changes nothing.
// It imports @hdl/core to encrypt the secrets it stores, which the library code in src/ may not
// do. Why that is allowed here: docs/adr/0018-seed-script-imports-core.md
import {
  decryptSecret,
  encryptSecret,
  generateWhsecSecret,
  hashApiKey,
  loadDotEnvFile,
  parseApiKey,
  parseEnv,
  parseMasterKey,
} from '@hdl/core';
import type { SecretContext } from '@hdl/core';
import { createPrismaClient } from '../src/index.js';
import type { PrismaClient } from '../src/index.js';

// Fixed ids make the seed repeatable. They are valid UUIDs; the app generates UUID v7 itself.
const DEMO = {
  tenantId: '019a7b00-0000-7000-8000-000000000001',
  apiKeyId: '019a7b00-0000-7000-8000-000000000002',
  sourceId: '019a7b00-0000-7000-8000-000000000010',
  destinationId: '019a7b00-0000-7000-8000-000000000020',
  connectionId: '019a7b00-0000-7000-8000-000000000030',
  tenantName: 'Demo Tenant',
  sourceSlug: 'demo-orders',
  bucket: 'demo',
  /** The schema default: 600 requests per minute. */
  ingestRateLimit: 600,
};

const LOADTEST = {
  tenantId: '019a7b00-0000-7000-8000-000000000101',
  apiKeyId: null,
  sourceId: '019a7b00-0000-7000-8000-000000000110',
  destinationId: '019a7b00-0000-7000-8000-000000000120',
  connectionId: '019a7b00-0000-7000-8000-000000000130',
  tenantName: 'Load Test Tenant',
  sourceSlug: 'loadtest',
  bucket: 'loadtest',
  /** High enough that the load test (NFR1) is never rate limited. */
  ingestRateLimit: 100_000_000,
};

type SeedTenant = typeof DEMO | typeof LOADTEST;

loadDotEnvFile();
const env = parseEnv();
const masterKey = parseMasterKey(env.SECRETS_MASTER_KEY);

/**
 * Returns the stored envelope if it still decrypts, otherwise a new encrypted `whsec_` secret.
 * Keeping the old value means a re-seed does not invalidate a secret someone already copied.
 * It stops decrypting when SECRETS_MASTER_KEY was replaced; then a fresh secret is the only fix.
 */
function keepOrCreateSecret(existing: string | null | undefined, context: SecretContext): string {
  if (existing) {
    try {
      decryptSecret(existing, masterKey, context);
      return existing;
    } catch {
      console.log(
        `  The stored ${context.purpose} no longer decrypts (new master key?). Replacing it.`,
      );
    }
  }
  return encryptSecret(generateWhsecSecret(), masterKey, context);
}

/** One tenant with a standard-webhooks source, a destination at the mock receiver, and a connection. */
async function seedTenant(prisma: PrismaClient, seed: SeedTenant): Promise<void> {
  const tenant = { name: seed.tenantName, ingestRateLimit: seed.ingestRateLimit };
  await prisma.tenant.upsert({
    where: { id: seed.tenantId },
    create: { id: seed.tenantId, ...tenant },
    update: tenant,
  });

  const existingSource = await prisma.source.findUnique({ where: { id: seed.sourceId } });
  const source = {
    tenantId: seed.tenantId,
    name: `${seed.tenantName} source`,
    slug: seed.sourceSlug,
    enabled: true,
    verificationMode: 'standard-webhooks',
    verificationConfig: { mode: 'standard-webhooks' },
    // Standard Webhooks senders put the event id in this header; it drives deduplication.
    dedupeHeader: 'webhook-id',
    secretEnc: keepOrCreateSecret(existingSource?.secretEnc, {
      tenantId: seed.tenantId,
      purpose: 'source-secret',
    }),
  };
  await prisma.source.upsert({
    where: { id: seed.sourceId },
    create: { id: seed.sourceId, ...source },
    update: source,
  });

  const existingDestination = await prisma.destination.findUnique({
    where: { id: seed.destinationId },
  });
  const destination = {
    tenantId: seed.tenantId,
    name: 'Mock receiver',
    url: `http://localhost:${env.MOCK_RECEIVER_PORT}/hook/${seed.bucket}`,
    enabled: true,
    disabledReason: null,
    signingSecretEnc: keepOrCreateSecret(existingDestination?.signingSecretEnc, {
      tenantId: seed.tenantId,
      purpose: 'destination-secret',
    }),
  };
  await prisma.destination.upsert({
    where: { id: seed.destinationId },
    create: { id: seed.destinationId, ...destination },
    update: destination,
  });

  // No filter: every event of the source goes to the destination.
  const connection = {
    tenantId: seed.tenantId,
    name: `${seed.sourceSlug} to mock receiver`,
    sourceId: seed.sourceId,
    destinationId: seed.destinationId,
    enabled: true,
  };
  await prisma.connection.upsert({
    where: { id: seed.connectionId },
    create: { id: seed.connectionId, ...connection },
    update: connection,
  });
}

/** Stores the demo tenant's API key the way every key is stored: a prefix and a SHA-256 hash. */
async function seedApiKey(prisma: PrismaClient, apiKey: string): Promise<void> {
  const parsed = parseApiKey(apiKey);
  if (!parsed) {
    throw new Error('SEED_API_KEY must look like hdl_<8 letters or digits>_<32 letters or digits>');
  }
  const row = {
    tenantId: DEMO.tenantId,
    name: 'Seed key',
    prefix: parsed.prefix,
    keyHash: hashApiKey(apiKey),
    revokedAt: null,
  };
  await prisma.apiKey.upsert({
    where: { id: DEMO.apiKeyId },
    create: { id: DEMO.apiKeyId, ...row },
    update: row,
  });
}

async function main(): Promise<void> {
  if (!env.SEED_API_KEY) {
    throw new Error('SEED_API_KEY is not set. Run `pnpm setup:env` or add it to .env.');
  }

  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    await seedTenant(prisma, DEMO);
    await seedApiKey(prisma, env.SEED_API_KEY);
    await seedTenant(prisma, LOADTEST);
  } finally {
    await prisma.$disconnect();
  }

  const apiUrl = `http://localhost:${env.PORT}`;
  console.log('Seed complete.');
  console.log('');
  console.log(`  Demo tenant       ${DEMO.tenantName}`);
  console.log(`  Source slug       ${DEMO.sourceSlug}`);
  console.log(`  Ingestion URL     ${apiUrl}/in/${DEMO.sourceSlug}`);
  console.log(`  Destination       http://localhost:${env.MOCK_RECEIVER_PORT}/hook/${DEMO.bucket}`);
  console.log(`  API key           ${env.SEED_API_KEY}`);
  console.log('');
  console.log(`  Load-test source  ${apiUrl}/in/${LOADTEST.sourceSlug}`);
  console.log('');
  console.log('Send a signed test webhook with: pnpm send-webhook');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
