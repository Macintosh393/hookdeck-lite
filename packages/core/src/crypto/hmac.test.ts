// Unit tests for webhook signing and verification. Each test name carries the id of the
// checklist line it covers (docs/SECURITY.md#security-test-checklist).
import crypto from 'node:crypto';
import type { VerificationConfig } from '@hdl/shared';
import { Webhook } from 'standardwebhooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeWhsecSecret,
  generateWhsecSecret,
  signGenericHmac,
  signStandardWebhook,
  verifyInboundSignature,
} from './hmac.js';
import type { HeaderBag, VerifyInboundInput } from './hmac.js';

const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const OTHER_SECRET = 'whsec_C2FVsBQIhrscChlQIMV+b5sSYspob7oD';
const NOW_MS = 1_800_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const TOLERANCE = 300;
const BODY = Buffer.from('{"type":"order.created","data":{"id":"ord_123"}}', 'utf8');
const STANDARD: VerificationConfig = { mode: 'standard-webhooks' };

/** Headers of a correctly signed Standard Webhooks request, with overrides for each test. */
function standardHeaders(overrides: Partial<Record<string, string | undefined>> = {}): HeaderBag {
  const id = 'msg_1';
  return {
    'webhook-id': id,
    'webhook-timestamp': String(NOW_SECONDS),
    'webhook-signature': signStandardWebhook({
      secret: SECRET,
      id,
      timestampSeconds: NOW_SECONDS,
      body: BODY,
    }),
    ...overrides,
  };
}

function verifyStandard(overrides: Partial<VerifyInboundInput> = {}) {
  return verifyInboundSignature({
    config: STANDARD,
    secret: SECRET,
    headers: standardHeaders(),
    rawBody: BODY,
    toleranceSeconds: TOLERANCE,
    nowMs: NOW_MS,
    ...overrides,
  });
}

/** Signs for a given timestamp, so tolerance tests have a valid signature and only the time is off. */
function headersAt(timestampSeconds: number): HeaderBag {
  return standardHeaders({
    'webhook-timestamp': String(timestampSeconds),
    'webhook-signature': signStandardWebhook({
      secret: SECRET,
      id: 'msg_1',
      timestampSeconds,
      body: BODY,
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('standard-webhooks verification', () => {
  it('SEC-IN-01 accepts a valid signature', () => {
    expect(verifyStandard()).toEqual({ ok: true });
  });

  it('SEC-IN-02 rejects a body with one flipped bit', () => {
    const tampered = Buffer.from(BODY);
    tampered[5] = tampered[5]! ^ 0b0000_0001;

    expect(verifyStandard({ rawBody: tampered })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    });
  });

  it('SEC-IN-03 rejects a signature made with a different secret', () => {
    expect(verifyStandard({ secret: OTHER_SECRET })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    });
  });

  it('SEC-IN-04 rejects a timestamp older than the tolerance', () => {
    const result = verifyStandard({ headers: headersAt(NOW_SECONDS - TOLERANCE - 1) });
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('SEC-IN-04 rejects a timestamp further in the future than the tolerance', () => {
    const result = verifyStandard({ headers: headersAt(NOW_SECONDS + TOLERANCE + 1) });
    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' });
  });

  it('SEC-IN-04 accepts a timestamp exactly at the boundary, in both directions', () => {
    expect(verifyStandard({ headers: headersAt(NOW_SECONDS - TOLERANCE) })).toEqual({ ok: true });
    expect(verifyStandard({ headers: headersAt(NOW_SECONDS + TOLERANCE) })).toEqual({ ok: true });
  });

  it.each([
    ['non-numeric', 'yesterday'],
    ['digits followed by letters', '123abc'],
    ['negative', `-${NOW_SECONDS}`],
    ['a decimal', `${NOW_SECONDS}.5`],
    ['padded with a space', ` ${NOW_SECONDS}`],
  ])('SEC-IN-05 rejects a %s timestamp', (_label, timestamp) => {
    const result = verifyStandard({ headers: standardHeaders({ 'webhook-timestamp': timestamp }) });
    expect(result).toEqual({ ok: false, reason: 'invalid_timestamp' });
  });

  it('SEC-IN-05 rejects an empty timestamp', () => {
    const result = verifyStandard({ headers: standardHeaders({ 'webhook-timestamp': '' }) });
    expect(result.ok).toBe(false);
  });

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
    'SEC-IN-06 rejects a request without the %s header',
    (header) => {
      const result = verifyStandard({ headers: standardHeaders({ [header]: undefined }) });
      expect(result).toEqual({ ok: false, reason: 'missing_header' });
    },
  );

  it('SEC-IN-07 accepts a header with two signatures where the second is valid', () => {
    const valid = standardHeaders()['webhook-signature'] as string;
    const stale = signStandardWebhook({
      secret: OTHER_SECRET,
      id: 'msg_1',
      timestampSeconds: NOW_SECONDS,
      body: BODY,
    });

    const result = verifyStandard({
      headers: standardHeaders({ 'webhook-signature': `${stale} ${valid}` }),
    });

    expect(result).toEqual({ ok: true });
  });

  it('SEC-IN-07 ignores signatures with an unknown version prefix', () => {
    const valid = standardHeaders()['webhook-signature'] as string;
    const sameBytesOtherVersion = valid.replace(/^v1,/, 'v2,');

    // The right bytes under the wrong version must not count...
    expect(
      verifyStandard({ headers: standardHeaders({ 'webhook-signature': sameBytesOtherVersion }) }),
    ).toEqual({ ok: false, reason: 'no_matching_signature' });
    // ...and an unknown entry next to a valid one must not break the valid one.
    expect(
      verifyStandard({
        headers: standardHeaders({ 'webhook-signature': `v1a,AAAA garbage ${valid}` }),
      }),
    ).toEqual({ ok: true });
  });

  it('SEC-IN-08 does not throw on a signature of a different length, and rejects it', () => {
    const tooShort = `v1,${Buffer.from('short').toString('base64')}`;
    const tooLong = `v1,${Buffer.alloc(64, 1).toString('base64')}`;

    for (const signature of [tooShort, tooLong, 'v1,']) {
      const run = () =>
        verifyStandard({ headers: standardHeaders({ 'webhook-signature': signature }) });
      expect(run).not.toThrow();
      expect(run()).toEqual({ ok: false, reason: 'no_matching_signature' });
    }
  });

  it('SEC-IN-14 compares signatures with crypto.timingSafeEqual', () => {
    const spy = vi.spyOn(crypto, 'timingSafeEqual');

    expect(verifyStandard()).toEqual({ ok: true });

    expect(spy).toHaveBeenCalledTimes(1);
    const [candidate, expected] = spy.mock.calls[0]!;
    expect(Buffer.isBuffer(candidate)).toBe(true);
    expect(Buffer.isBuffer(expected)).toBe(true);
  });

  it('rejects when the source has no secret or a malformed one', () => {
    expect(verifyStandard({ secret: null })).toEqual({ ok: false, reason: 'invalid_secret' });
    expect(verifyStandard({ secret: 'not-a-whsec-secret' })).toEqual({
      ok: false,
      reason: 'invalid_secret',
    });
  });
});

describe('generic-hmac verification', () => {
  const GITHUB_SECRET = 'my-github-webhook-secret';
  const githubStyle: VerificationConfig = {
    mode: 'generic-hmac',
    signatureHeader: 'x-hub-signature-256',
    signaturePrefix: 'sha256=',
    signatureEncoding: 'hex',
  };

  function verifyGeneric(config: VerificationConfig, headers: HeaderBag, nowMs = NOW_MS) {
    return verifyInboundSignature({
      config,
      secret: GITHUB_SECRET,
      headers,
      rawBody: BODY,
      toleranceSeconds: TOLERANCE,
      nowMs,
    });
  }

  it('SEC-IN-09 accepts hex with a prefix (GitHub style)', () => {
    const signature = signGenericHmac({
      secret: GITHUB_SECRET,
      body: BODY,
      encoding: 'hex',
      prefix: 'sha256=',
    });
    // Cross-check against an HMAC computed here, independent of our signing helper.
    const independent = crypto.createHmac('sha256', GITHUB_SECRET).update(BODY).digest('hex');
    expect(signature).toBe(`sha256=${independent}`);

    expect(verifyGeneric(githubStyle, { 'x-hub-signature-256': signature })).toEqual({ ok: true });
  });

  it('SEC-IN-09 accepts the base64 variant without a prefix', () => {
    const config: VerificationConfig = {
      mode: 'generic-hmac',
      signatureHeader: 'x-signature',
      signatureEncoding: 'base64',
    };
    const signature = signGenericHmac({ secret: GITHUB_SECRET, body: BODY, encoding: 'base64' });

    expect(verifyGeneric(config, { 'x-signature': signature })).toEqual({ ok: true });
  });

  it('SEC-IN-09 rejects a wrong signature, a missing prefix and a missing header', () => {
    const signature = signGenericHmac({
      secret: 'wrong',
      body: BODY,
      encoding: 'hex',
      prefix: 'sha256=',
    });
    const withoutPrefix = signGenericHmac({ secret: GITHUB_SECRET, body: BODY, encoding: 'hex' });

    expect(verifyGeneric(githubStyle, { 'x-hub-signature-256': signature })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    });
    expect(verifyGeneric(githubStyle, { 'x-hub-signature-256': withoutPrefix })).toEqual({
      ok: false,
      reason: 'no_matching_signature',
    });
    expect(verifyGeneric(githubStyle, {})).toEqual({ ok: false, reason: 'missing_header' });
  });

  describe('with a timestamp header', () => {
    const withTimestamp: VerificationConfig = {
      mode: 'generic-hmac',
      signatureHeader: 'x-signature',
      signatureEncoding: 'hex',
      timestampHeader: 'x-timestamp',
    };

    function signedAt(timestampSeconds: number): HeaderBag {
      return {
        'x-timestamp': String(timestampSeconds),
        'x-signature': signGenericHmac({
          secret: GITHUB_SECRET,
          body: BODY,
          encoding: 'hex',
          timestampSeconds,
        }),
      };
    }

    it('SEC-IN-10 enforces the tolerance window', () => {
      expect(verifyGeneric(withTimestamp, signedAt(NOW_SECONDS))).toEqual({ ok: true });
      expect(verifyGeneric(withTimestamp, signedAt(NOW_SECONDS - TOLERANCE - 1))).toEqual({
        ok: false,
        reason: 'timestamp_out_of_tolerance',
      });
    });

    it('SEC-IN-10 includes the timestamp in the signed content', () => {
      // A valid signature over the body alone must not pass once a timestamp header is configured.
      const bodyOnly = signGenericHmac({ secret: GITHUB_SECRET, body: BODY, encoding: 'hex' });
      const headers = { 'x-timestamp': String(NOW_SECONDS), 'x-signature': bodyOnly };

      expect(verifyGeneric(withTimestamp, headers)).toEqual({
        ok: false,
        reason: 'no_matching_signature',
      });
    });

    it('SEC-IN-10 rejects a missing or malformed timestamp header', () => {
      const headers = signedAt(NOW_SECONDS);

      expect(verifyGeneric(withTimestamp, { ...headers, 'x-timestamp': undefined })).toEqual({
        ok: false,
        reason: 'missing_header',
      });
      expect(verifyGeneric(withTimestamp, { ...headers, 'x-timestamp': '123abc' })).toEqual({
        ok: false,
        reason: 'invalid_timestamp',
      });
    });
  });

  it('SEC-IN-10 without a timestamp header, the signature stays valid at any time', () => {
    const signature = signGenericHmac({
      secret: GITHUB_SECRET,
      body: BODY,
      encoding: 'hex',
      prefix: 'sha256=',
    });
    const aYearLater = NOW_MS + 365 * 24 * 3600 * 1000;

    expect(verifyGeneric(githubStyle, { 'x-hub-signature-256': signature }, aYearLater)).toEqual({
      ok: true,
    });
  });
});

describe('mode none', () => {
  it('accepts anything without looking at headers', () => {
    const result = verifyInboundSignature({
      config: { mode: 'none' },
      secret: null,
      headers: {},
      rawBody: BODY,
      toleranceSeconds: TOLERANCE,
      nowMs: NOW_MS,
    });
    expect(result).toEqual({ ok: true });
  });
});

describe('compatibility with the official standardwebhooks package', () => {
  // The official library reads the real clock, so these tests sign with the current time.
  const nowSeconds = Math.floor(Date.now() / 1000);
  const body = BODY.toString('utf8');

  it('SEC-OUT-01 the official package verifies a signature we produced', () => {
    const headers = {
      'webhook-id': 'msg_out_1',
      'webhook-timestamp': String(nowSeconds),
      'webhook-signature': signStandardWebhook({
        secret: SECRET,
        id: 'msg_out_1',
        timestampSeconds: nowSeconds,
        body,
      }),
    };

    expect(() => new Webhook(SECRET).verify(body, headers)).not.toThrow();
    // And it must reject the same headers with another secret, or the test proves nothing.
    expect(() => new Webhook(OTHER_SECRET).verify(body, headers)).toThrow();
  });

  it('SEC-OUT-01 we verify a signature the official package produced', () => {
    const signature = new Webhook(SECRET).sign('msg_in_1', new Date(nowSeconds * 1000), body);

    const result = verifyInboundSignature({
      config: STANDARD,
      secret: SECRET,
      headers: {
        'webhook-id': 'msg_in_1',
        'webhook-timestamp': String(nowSeconds),
        'webhook-signature': signature,
      },
      rawBody: Buffer.from(body, 'utf8'),
      toleranceSeconds: TOLERANCE,
      nowMs: Date.now(),
    });

    expect(result).toEqual({ ok: true });
  });
});

describe('secret helpers', () => {
  it('generates whsec_ secrets with 32 random bytes', () => {
    const first = generateWhsecSecret();
    const second = generateWhsecSecret();

    expect(first).toMatch(/^whsec_/);
    expect(decodeWhsecSecret(first)).toHaveLength(32);
    expect(first).not.toBe(second);
  });

  it('refuses a secret without the whsec_ prefix or without key bytes', () => {
    expect(() => decodeWhsecSecret('plain-secret')).toThrow();
    expect(() => decodeWhsecSecret('whsec_')).toThrow();
  });
});
