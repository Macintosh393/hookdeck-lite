// Unit tests for the Zod schemas of @hdl/shared: valid and invalid samples per schema
// (docs/TESTING.md#unit).
import { describe, expect, it } from 'vitest';
import {
  connectionCreateSchema,
  connectionUpdateSchema,
  destinationCreateSchema,
  destinationUpdateSchema,
  listQuerySchema,
  sourceCreateSchema,
  sourceUpdateSchema,
} from './api-inputs.js';
import { verificationConfigSchema } from './verification-config.js';

const SOURCE_ID = '019a7b10-0000-7000-8000-000000000010';
const DESTINATION_ID = '019a7b20-0000-7000-8000-000000000020';

describe('verificationConfigSchema', () => {
  it('accepts the three modes', () => {
    expect(verificationConfigSchema.parse({ mode: 'standard-webhooks' })).toEqual({
      mode: 'standard-webhooks',
    });
    expect(verificationConfigSchema.parse({ mode: 'none' })).toEqual({ mode: 'none' });
    expect(
      verificationConfigSchema.safeParse({
        mode: 'generic-hmac',
        signatureHeader: 'x-signature',
        signatureEncoding: 'base64',
        timestampHeader: 'x-timestamp',
      }).success,
    ).toBe(true);
  });

  it('lowercases header names, so GitHub-style config is stored canonically', () => {
    const config = verificationConfigSchema.parse({
      mode: 'generic-hmac',
      signatureHeader: 'X-Hub-Signature-256',
      signaturePrefix: 'sha256=',
      signatureEncoding: 'hex',
    });
    expect(config).toEqual({
      mode: 'generic-hmac',
      signatureHeader: 'x-hub-signature-256',
      signaturePrefix: 'sha256=',
      signatureEncoding: 'hex',
    });
  });

  it.each([
    [{}, 'no mode'],
    [{ mode: 'stripe' }, 'unknown mode'],
    [{ mode: 'generic-hmac', signatureEncoding: 'hex' }, 'missing signatureHeader'],
    [{ mode: 'generic-hmac', signatureHeader: 'x-sig' }, 'missing signatureEncoding'],
    [
      { mode: 'generic-hmac', signatureHeader: 'x-sig', signatureEncoding: 'base32' },
      'bad encoding',
    ],
    [
      { mode: 'generic-hmac', signatureHeader: 'x sig', signatureEncoding: 'hex' },
      'bad header name',
    ],
    [{ mode: 'standard-webhooks', signatureHeader: 'x-sig' }, 'extra key for the mode'],
    [{ mode: 'none', secret: 'abc' }, 'unknown key'],
  ])('rejects %j (%s)', (value, _reason) => {
    expect(verificationConfigSchema.safeParse(value).success).toBe(false);
  });
});

describe('sourceCreateSchema', () => {
  it('accepts a standard-webhooks source without a secret (one is generated)', () => {
    const result = sourceCreateSchema.safeParse({
      name: 'Stripe (test)',
      verificationMode: 'standard-webhooks',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a GitHub-style source and lowercases the dedupe header', () => {
    const parsed = sourceCreateSchema.parse({
      name: 'GitHub',
      verificationMode: 'generic-hmac',
      verificationConfig: {
        mode: 'generic-hmac',
        signatureHeader: 'x-hub-signature-256',
        signaturePrefix: 'sha256=',
        signatureEncoding: 'hex',
      },
      secret: 'my-github-webhook-secret',
      dedupeHeader: 'X-GitHub-Delivery',
    });
    expect(parsed.dedupeHeader).toBe('x-github-delivery');
  });

  it('accepts dedupeHeader: null, which switches deduplication off', () => {
    const parsed = sourceCreateSchema.parse({
      name: 'No dedupe',
      verificationMode: 'none',
      dedupeHeader: null,
    });
    expect(parsed.dedupeHeader).toBeNull();
  });

  it.each([
    [{ verificationMode: 'none' }, 'name is required'],
    [{ name: '', verificationMode: 'none' }, 'name is empty'],
    [{ name: '   ', verificationMode: 'none' }, 'name is only spaces'],
    [{ name: 'x'.repeat(101), verificationMode: 'none' }, 'name is too long'],
    [{ name: 'A', verificationMode: 'hmac' }, 'unknown mode'],
    [{ name: 'A', verificationMode: 'none', extra: true }, 'unknown key'],
    [{ name: 'A', verificationMode: 'none', secret: 's' }, 'secret is forbidden for none'],
    [
      { name: 'A', verificationMode: 'generic-hmac', secret: 's' },
      'config is required for generic-hmac',
    ],
    [
      {
        name: 'A',
        verificationMode: 'generic-hmac',
        verificationConfig: {
          mode: 'generic-hmac',
          signatureHeader: 'x-sig',
          signatureEncoding: 'hex',
        },
      },
      'secret is required for generic-hmac',
    ],
    [
      { name: 'A', verificationMode: 'standard-webhooks', verificationConfig: { mode: 'none' } },
      'config mode differs from verificationMode',
    ],
    [{ name: 'A', verificationMode: 'none', secret: 'x'.repeat(257) }, 'secret is too long'],
  ])('rejects %j (%s)', (value, _reason) => {
    expect(sourceCreateSchema.safeParse(value).success).toBe(false);
  });
});

describe('sourceUpdateSchema', () => {
  it('accepts a partial update', () => {
    expect(sourceUpdateSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(sourceUpdateSchema.safeParse({ name: 'New name', dedupeHeader: null }).success).toBe(
      true,
    );
  });

  it('rejects an empty body and unknown keys', () => {
    expect(sourceUpdateSchema.safeParse({}).success).toBe(false);
    expect(sourceUpdateSchema.safeParse({ slug: 'new-slug' }).success).toBe(false);
  });
});

describe('destination schemas', () => {
  it('accepts http and https URLs', () => {
    expect(
      destinationCreateSchema.safeParse({
        name: 'Orders',
        url: 'https://orders.example.com/webhooks',
      }).success,
    ).toBe(true);
    expect(
      destinationCreateSchema.safeParse({ name: 'Local', url: 'http://localhost:4000/hook/demo' })
        .success,
    ).toBe(true);
  });

  it.each([
    [{ name: 'A', url: 'ftp://example.com/file' }, 'scheme is not http or https'],
    [{ name: 'A', url: 'javascript:alert(1)' }, 'scheme is not http or https'],
    [{ name: 'A', url: 'not a url' }, 'not a URL'],
    [{ name: 'A', url: `https://example.com/${'a'.repeat(2048)}` }, 'URL is too long'],
    [{ name: 'A' }, 'url is required'],
    [{ name: 'A', url: 'https://example.com', signingSecret: 'whsec_x' }, 'unknown key'],
  ])('rejects %j (%s)', (value, _reason) => {
    expect(destinationCreateSchema.safeParse(value).success).toBe(false);
  });

  it('validates updates: partial bodies pass, empty and invalid ones fail', () => {
    expect(destinationUpdateSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(destinationUpdateSchema.safeParse({ url: 'https://example.com/v2' }).success).toBe(true);
    expect(destinationUpdateSchema.safeParse({}).success).toBe(false);
    expect(destinationUpdateSchema.safeParse({ url: 'file:///etc/passwd' }).success).toBe(false);
  });
});

describe('connection schemas', () => {
  const base = { name: 'Paid orders', sourceId: SOURCE_ID, destinationId: DESTINATION_ID };

  it('defaults enabled to true and accepts a missing or null filter', () => {
    expect(connectionCreateSchema.parse(base).enabled).toBe(true);
    expect(connectionCreateSchema.safeParse({ ...base, filter: null }).success).toBe(true);
  });

  it('accepts a valid filter', () => {
    const filter = { body: { type: 'order.created', 'data.amount': { $gte: 100 } } };
    expect(connectionCreateSchema.safeParse({ ...base, filter }).success).toBe(true);
  });

  it('rejects an invalid filter and reports where it is wrong (AC6.2)', () => {
    const result = connectionCreateSchema.safeParse({
      ...base,
      filter: { body: { a: { $in: [] } } },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['filter', 'body', 'a', '$in']);
  });

  it('reports a whole-filter problem on the filter field itself (AC6.2)', () => {
    const tooDeep = { $not: { $not: { $not: { $not: { $not: { $not: { body: { a: 1 } } } } } } } };
    const result = connectionCreateSchema.safeParse({ ...base, filter: tooDeep });
    expect(result.error?.issues[0]?.path).toEqual(['filter']);
  });

  it.each([
    [{ ...base, sourceId: 'not-a-uuid' }, 'sourceId is not a UUID'],
    [{ name: 'A', sourceId: SOURCE_ID }, 'destinationId is required'],
    [{ ...base, tenantId: SOURCE_ID }, 'unknown key'],
  ])('rejects %j (%s)', (value, _reason) => {
    expect(connectionCreateSchema.safeParse(value).success).toBe(false);
  });

  it('validates updates: filter can be replaced or removed, source cannot change', () => {
    expect(connectionUpdateSchema.safeParse({ filter: null }).success).toBe(true);
    expect(
      connectionUpdateSchema.safeParse({ filter: { headers: { 'x-env': 'prod' } } }).success,
    ).toBe(true);
    expect(connectionUpdateSchema.safeParse({ filter: { payload: {} } }).success).toBe(false);
    expect(connectionUpdateSchema.safeParse({ sourceId: SOURCE_ID }).success).toBe(false);
    expect(connectionUpdateSchema.safeParse({}).success).toBe(false);
  });
});

describe('listQuerySchema', () => {
  it('defaults limit to 50 and coerces query-string numbers', () => {
    expect(listQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(listQuerySchema.parse({ limit: '25', cursor: 'abc' })).toEqual({
      limit: 25,
      cursor: 'abc',
    });
  });

  it.each([{ limit: '0' }, { limit: '101' }, { limit: 'ten' }, { limit: '1.5' }, { cursor: '' }])(
    'rejects %j',
    (value) => {
      expect(listQuerySchema.safeParse(value).success).toBe(false);
    },
  );
});
