// Demo helper: signs a sample `order.created` event with Standard Webhooks and posts it to the
// ingestion endpoint, the way a provider would. Run: pnpm send-webhook [flags]
//
//   --source <slug>    source to post to (default: demo-orders, created by the seed)
//   --url <base>       base URL of the api (default: http://localhost:<PORT>)
//   --secret <whsec>   the source's secret; if omitted it is read from the database and decrypted
//   --same-id          reuse the previous webhook id, so the api answers "duplicate"
//   --bad-signature    send a wrong signature, so the api answers 401
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import {
  decryptSecret,
  loadDotEnvFile,
  parseEnv,
  parseMasterKey,
  signStandardWebhook,
} from '@hdl/core';
import { createPrismaClient } from '@hdl/database';

const repoRoot = resolve(import.meta.dirname, '..');
/** Remembers the last webhook id between runs, for --same-id. Listed in .gitignore. */
const lastIdFile = resolve(repoRoot, '.send-webhook-last-id');

const { values: flags } = parseArgs({
  options: {
    source: { type: 'string', default: 'demo-orders' },
    url: { type: 'string' },
    secret: { type: 'string' },
    'same-id': { type: 'boolean', default: false },
    'bad-signature': { type: 'boolean', default: false },
  },
});

loadDotEnvFile(repoRoot);
const env = parseEnv();

/** Reads the source's encrypted secret from Postgres and decrypts it with the master key. */
async function readSecretFromDatabase(slug: string): Promise<string> {
  const prisma = createPrismaClient(env.DATABASE_URL);
  try {
    const source = await prisma.source.findUnique({ where: { slug } });
    if (!source) throw new Error(`No source with slug "${slug}". Run: pnpm db:seed`);
    if (source.verificationMode !== 'standard-webhooks' || source.secretEnc === null) {
      throw new Error(`Source "${slug}" is not a standard-webhooks source with a secret.`);
    }
    return decryptSecret(source.secretEnc, parseMasterKey(env.SECRETS_MASTER_KEY), {
      tenantId: source.tenantId,
      purpose: 'source-secret',
    });
  } finally {
    await prisma.$disconnect();
  }
}

function pickWebhookId(): string {
  if (flags['same-id']) {
    if (!existsSync(lastIdFile)) {
      throw new Error('--same-id needs a previous run. Run `pnpm send-webhook` once first.');
    }
    return readFileSync(lastIdFile, 'utf8').trim();
  }
  const id = `msg_${randomUUID()}`;
  writeFileSync(lastIdFile, `${id}\n`);
  return id;
}

async function main(): Promise<void> {
  const secret = flags.secret ?? (await readSecretFromDatabase(flags.source));
  const id = pickWebhookId();
  const timestampSeconds = Math.floor(Date.now() / 1000);

  // The body is built once, as a string. The same bytes are signed and sent.
  const body = JSON.stringify({
    type: 'order.created',
    timestamp: new Date().toISOString(),
    data: { id: `ord_${randomUUID().slice(0, 8)}`, amount: 250, currency: 'EUR' },
  });

  const signature = flags['bad-signature']
    ? `v1,${Buffer.alloc(32).toString('base64')}` // 32 zero bytes: the right length, the wrong value
    : signStandardWebhook({ secret, id, timestampSeconds, body });

  const baseUrl = (flags.url ?? `http://localhost:${env.PORT}`).replace(/\/$/, '');
  const url = `${baseUrl}/in/${flags.source}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': String(timestampSeconds),
      'webhook-signature': signature,
    },
    body,
  });

  console.log(`POST ${url}`);
  console.log(`webhook-id: ${id}`);
  console.log(`${response.status} ${await response.text()}`);
  const retryAfter = response.headers.get('retry-after');
  if (retryAfter !== null) console.log(`retry-after: ${retryAfter}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
