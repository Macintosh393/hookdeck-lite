// Environment configuration: one Zod schema for every variable in docs/ARCHITECTURE.md#configuration.
// The api, the worker and the scripts call parseEnv() once at startup and pass the result around,
// so a missing or malformed setting stops the process before it accepts any work.
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

/** AES-256 needs a key of exactly this many bytes. See docs/SECURITY.md#secret-encryption */
export const MASTER_KEY_BYTES = 32;

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/** A whole number greater than zero, read from a string such as "3001". */
const positiveInt = (defaultValue: number) =>
  z.coerce.number().int().positive().default(defaultValue);

/** "a, b,c" -> ["a", "b", "c"]. An unset variable gives an empty list. */
const commaSeparatedList = (defaultValue: string) =>
  z
    .string()
    .default(defaultValue)
    .transform((value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );

/**
 * True when `value` is the base64 form of exactly 32 bytes.
 * Buffer.from() ignores characters that are not base64, so we also encode the result again and
 * compare: a typo in the key must fail at startup, not decrypt to garbage later.
 */
function isValidMasterKey(value: string): boolean {
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === MASTER_KEY_BYTES && decoded.toString('base64') === value;
}

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  PORT: positiveInt(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  BULLMQ_PREFIX: z.string().min(1).default('hdl'),
  CORS_ORIGINS: commaSeparatedList('http://localhost:3000'),
  SECRETS_MASTER_KEY: z
    .string()
    .refine(isValidMasterKey, `must be the base64 encoding of exactly ${MASTER_KEY_BYTES} bytes`),
  SSRF_ALLOWLIST: commaSeparatedList('').transform((hosts) => hosts.map((h) => h.toLowerCase())),
  SIGNATURE_TOLERANCE_SECONDS: positiveInt(300),
  INGEST_MAX_BODY_BYTES: positiveInt(1_048_576),
  DELIVERY_MAX_ATTEMPTS: positiveInt(10),
  BACKOFF_BASE_MS: positiveInt(30_000),
  BACKOFF_CAP_MS: positiveInt(3_600_000),
  DELIVERY_TIMEOUT_MS: positiveInt(15_000),
  DELIVERY_MAX_RESPONSE_BYTES: positiveInt(16_384),
  DELIVERY_CONCURRENCY: positiveInt(50),
  FANOUT_CONCURRENCY: positiveInt(10),
  SWEEPER_INTERVAL_MS: positiveInt(15_000),
  SWEEPER_STUCK_AFTER_MS: positiveInt(30_000),
  RETENTION_DAYS: positiveInt(30),
  // Only the seed script needs it; the seed checks the format itself.
  SEED_API_KEY: z.string().optional(),
  NEXT_PUBLIC_API_URL: z.string().default('http://localhost:3001'),
  MOCK_RECEIVER_PORT: positiveInt(4000),
});

/** The parsed configuration. Keys keep their canonical UPPER_CASE names. */
export type Env = z.infer<typeof envSchema>;

/**
 * Validates the environment and applies the defaults. Throws one Error that names every bad
 * variable. The message never contains a value, because some of them are secrets.
 */
export function parseEnv(source: Record<string, string | undefined> = process.env): Env {
  // `.env` files write "unset" as `NAME=`. Treat an empty string like a missing variable,
  // so the default applies instead of failing on "".
  const withoutEmpty: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value !== undefined && value !== '') withoutEmpty[name] = value;
  }

  const result = envSchema.safeParse(withoutEmpty);
  if (result.success) return result.data;

  const problems = result.error.issues.map((issue) => {
    const name = issue.path.join('.');
    const missing = !(name in withoutEmpty);
    return `  ${name}: ${missing ? 'is required' : issue.message}`;
  });
  throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
}

/**
 * Loads the repository's root `.env` into process.env, if there is one. Returns the path it
 * loaded, or null. Variables that are already set are never overwritten, so CI and `.env.test`
 * win over the file. In production there is no `.env`; the platform sets the variables.
 */
export function loadDotEnvFile(startDirectory: string = process.cwd()): string | null {
  // The apps run with their own folder as the working directory, so walk up to the repo root.
  let directory = resolve(startDirectory);
  for (;;) {
    if (existsSync(resolve(directory, 'pnpm-workspace.yaml'))) break;
    const parent = dirname(directory);
    if (parent === directory) return null; // reached the filesystem root
    directory = parent;
  }

  const envFile = resolve(directory, '.env');
  if (!existsSync(envFile)) return null;
  process.loadEnvFile(envFile);
  return envFile;
}
