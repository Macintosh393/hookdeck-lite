// Unit tests for environment parsing: defaults, coercion, and the startup failures that
// AC16.3 and SEC-ENC-05 require.
import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDotEnvFile, parseEnv } from './env.js';

const MASTER_KEY = crypto.randomBytes(32).toString('base64');

/** The three variables that have no default. */
const required = {
  DATABASE_URL: 'postgresql://hookdeck:hookdeck@localhost:5432/hookdeck',
  REDIS_URL: 'redis://localhost:6379/0',
  SECRETS_MASTER_KEY: MASTER_KEY,
};

describe('parseEnv', () => {
  it('applies the documented defaults', () => {
    const env = parseEnv(required);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 3001,
      BULLMQ_PREFIX: 'hdl',
      CORS_ORIGINS: ['http://localhost:3000'],
      SSRF_ALLOWLIST: [],
      SIGNATURE_TOLERANCE_SECONDS: 300,
      INGEST_MAX_BODY_BYTES: 1_048_576,
      DELIVERY_MAX_ATTEMPTS: 10,
      BACKOFF_BASE_MS: 30_000,
      BACKOFF_CAP_MS: 3_600_000,
      DELIVERY_TIMEOUT_MS: 15_000,
      DELIVERY_MAX_RESPONSE_BYTES: 16_384,
      DELIVERY_CONCURRENCY: 50,
      FANOUT_CONCURRENCY: 10,
      SWEEPER_INTERVAL_MS: 15_000,
      SWEEPER_STUCK_AFTER_MS: 30_000,
      RETENTION_DAYS: 30,
      NEXT_PUBLIC_API_URL: 'http://localhost:3001',
      MOCK_RECEIVER_PORT: 4000,
    });
  });

  it('turns numeric strings into numbers and lists into arrays', () => {
    const env = parseEnv({
      ...required,
      PORT: '8080',
      DELIVERY_MAX_ATTEMPTS: '4',
      CORS_ORIGINS: 'https://a.example, https://b.example',
      SSRF_ALLOWLIST: 'LocalHost,127.0.0.1, Mock-Receiver ,',
    });

    expect(env.PORT).toBe(8080);
    expect(env.DELIVERY_MAX_ATTEMPTS).toBe(4);
    expect(env.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(env.SSRF_ALLOWLIST).toEqual(['localhost', '127.0.0.1', 'mock-receiver']);
  });

  it('accepts LOG_LEVEL=silent, which the integration tests use', () => {
    expect(parseEnv({ ...required, LOG_LEVEL: 'silent' }).LOG_LEVEL).toBe('silent');
  });

  it('treats an empty value like a missing one', () => {
    const env = parseEnv({ ...required, PORT: '', SSRF_ALLOWLIST: '' });

    expect(env.PORT).toBe(3001);
    expect(env.SSRF_ALLOWLIST).toEqual([]);
  });

  it('AC16.3 refuses to start without SECRETS_MASTER_KEY', () => {
    const { SECRETS_MASTER_KEY: _omitted, ...withoutKey } = required;

    expect(() => parseEnv(withoutKey)).toThrow(/SECRETS_MASTER_KEY: is required/);
    expect(() => parseEnv({ ...withoutKey, SECRETS_MASTER_KEY: '' })).toThrow(/SECRETS_MASTER_KEY/);
  });

  it.each([
    ['16 bytes', crypto.randomBytes(16).toString('base64')],
    ['33 bytes', crypto.randomBytes(33).toString('base64')],
    ['not base64', 'this is definitely not a base64 key!!'],
  ])('AC16.3 SEC-ENC-05 refuses a SECRETS_MASTER_KEY of %s', (_label, key) => {
    expect(() => parseEnv({ ...required, SECRETS_MASTER_KEY: key })).toThrow(/exactly 32 bytes/);
  });

  it('never puts a value in the error message', () => {
    const badKey = crypto.randomBytes(16).toString('base64');

    let message = '';
    try {
      parseEnv({ ...required, SECRETS_MASTER_KEY: badKey, PORT: 'abc' });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain('SECRETS_MASTER_KEY');
    expect(message).toContain('PORT');
    expect(message).not.toContain(badKey);
  });

  it('names every missing or invalid variable in one error', () => {
    expect(() => parseEnv({ PORT: '-1', LOG_LEVEL: 'loud' })).toThrow(
      /DATABASE_URL: is required[\s\S]*REDIS_URL: is required/,
    );
    expect(() => parseEnv({ ...required, PORT: '-1' })).toThrow(/PORT/);
    expect(() => parseEnv({ ...required, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});

describe('loadDotEnvFile', () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    delete process.env.HDL_TEST_FROM_FILE;
    delete process.env.HDL_TEST_ALREADY_SET;
  });

  it('finds the root .env from a nested folder and keeps variables that are already set', () => {
    directory = mkdtempSync(join(tmpdir(), 'hdl-env-'));
    writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');
    writeFileSync(
      join(directory, '.env'),
      'HDL_TEST_FROM_FILE=from-file\nHDL_TEST_ALREADY_SET=from-file\n',
    );
    const nested = join(directory, 'apps', 'api');
    mkdirSync(nested, { recursive: true });
    process.env.HDL_TEST_ALREADY_SET = 'from-process';

    const loaded = loadDotEnvFile(nested);

    expect(loaded).toBe(join(directory, '.env'));
    expect(process.env.HDL_TEST_FROM_FILE).toBe('from-file');
    expect(process.env.HDL_TEST_ALREADY_SET).toBe('from-process');
  });

  it('returns null when the repository has no .env', () => {
    directory = mkdtempSync(join(tmpdir(), 'hdl-env-'));
    writeFileSync(join(directory, 'pnpm-workspace.yaml'), 'packages: []\n');

    expect(loadDotEnvFile(directory)).toBeNull();
  });
});
