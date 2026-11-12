// One-time local setup: creates .env from .env.example and fills in a fresh SECRETS_MASTER_KEY.
// Run with `pnpm setup:env`. It never overwrites an existing .env.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const examplePath = resolve(repoRoot, '.env.example');
const envPath = resolve(repoRoot, '.env');

if (existsSync(envPath)) {
  console.log('.env already exists. Nothing changed.');
} else {
  // 32 random bytes is the key size AES-256 needs. See docs/SECURITY.md#secret-encryption
  const masterKey = randomBytes(32).toString('base64');
  const example = readFileSync(examplePath, 'utf8');
  const env = example.replace(/^SECRETS_MASTER_KEY=.*$/m, `SECRETS_MASTER_KEY=${masterKey}`);
  writeFileSync(envPath, env);
  console.log('Created .env with a new SECRETS_MASTER_KEY. Keep this file out of version control.');
}
