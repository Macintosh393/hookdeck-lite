// Integration tests for POST /in/:sourceSlug against the real Postgres and Redis.
// Each test name carries the acceptance criterion (docs/PRD.md) or checklist id
// (docs/SECURITY.md#security-test-checklist) it covers.
import { randomUUID } from 'node:crypto';
import {
  createApiSubscriberConnection,
  createLogger,
  decryptSecret,
  parseMasterKey,
  signGenericHmac,
  streamChannel,
} from '@hdl/core';
import type { ErrorResponse, IngestResponse, StreamMessage } from '@hdl/shared';
import { Webhook } from 'standardwebhooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SourceCache } from '../src/ingest/source-cache.js';
import { createTenant, createTestApp, eventually, SAMPLE_BODY, signedRequest } from './helpers.js';
import type { TestApp, TestSource, TestTenant } from './helpers.js';

const MAX_BODY_BYTES = 4096;

describe('POST /in/:sourceSlug', () => {
  let t: TestApp;
  let tenant: TestTenant;
  let otherTenant: TestTenant;
  let source: TestSource;

  beforeAll(async () => {
    t = await createTestApp({ INGEST_MAX_BODY_BYTES: String(MAX_BODY_BYTES) });
    tenant = await createTenant(t.prisma, t.env);
    otherTenant = await createTenant(t.prisma, t.env);
    source = await tenant.addSource();
  });

  afterAll(async () => {
    await tenant.remove();
    await otherTenant.remove();
    await t.close();
  });

  const eventCount = (sourceId: string) => t.prisma.event.count({ where: { sourceId } });
  const jobCount = () => t.fanoutQueue.getJobCountByTypes('waiting', 'delayed', 'active');

  describe('M1: fast, durable ingestion', () => {
    it('AC1.1 AC1.2 a valid request returns 202 with the id of a stored RECEIVED event', async () => {
      const response = await t.app.inject(signedRequest(source, { query: '?a=1&b=x&b=y' }));

      expect(response.statusCode).toBe(202);
      const body = response.json<IngestResponse>();
      expect(body).toEqual({ id: expect.any(String) as string, status: 'accepted' });

      const event = await t.prisma.event.findUniqueOrThrow({ where: { id: body.id } });
      expect(event).toMatchObject({
        tenantId: tenant.id,
        sourceId: source.id,
        status: 'RECEIVED',
        contentType: 'application/json',
        body: SAMPLE_BODY,
        bodyBytes: Buffer.byteLength(SAMPLE_BODY),
        query: { a: '1', b: ['x', 'y'] },
      });
    });

    it('enqueues a fanout.event job whose id is the event id', async () => {
      const response = await t.app.inject(signedRequest(source));
      const { id } = response.json<IngestResponse>();

      const job = await t.fanoutQueue.getJob(id);
      expect(job?.name).toBe('fanout.event');
      expect(job?.data).toEqual({ eventId: id, tenantId: tenant.id });
    });

    it('publishes event.received on the tenant channel', async () => {
      const subscriber = createApiSubscriberConnection(
        t.env.REDIS_URL,
        createLogger({ level: 'silent', name: 'test' }),
      );
      const messages: StreamMessage[] = [];
      subscriber.on('message', (_channel, message) => {
        messages.push(JSON.parse(message) as StreamMessage);
      });
      await subscriber.subscribe(streamChannel(tenant.id));

      const response = await t.app.inject(signedRequest(source));
      const { id } = response.json<IngestResponse>();

      const message = await eventually(() => messages.find((m) => m.type === 'event.received'));
      expect(message.data).toEqual({ eventId: id, sourceId: source.id });
      await subscriber.quit();
    });

    it('AC1.5 an unknown source slug returns 404', async () => {
      const response = await t.app.inject({
        ...signedRequest(source),
        url: '/in/no-such-source',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorResponse>().error.code).toBe('NOT_FOUND');
    });

    it('AC1.5 a disabled source returns 404, like an unknown one', async () => {
      const disabled = await tenant.addSource({ enabled: false });

      const response = await t.app.inject(signedRequest(disabled));

      expect(response.statusCode).toBe(404);
      expect(response.json<ErrorResponse>().error).toMatchObject({
        code: 'NOT_FOUND',
        message: 'Source not found.',
      });
      expect(await eventCount(disabled.id)).toBe(0);
    });

    it('AC1.6 SEC-LIM-01 a body over INGEST_MAX_BODY_BYTES returns 413; one at the limit passes', async () => {
      const filler = (bytes: number) => `{"pad":"${'x'.repeat(bytes - 10)}"}`;
      const atLimit = filler(MAX_BODY_BYTES);
      const overLimit = filler(MAX_BODY_BYTES + 1);
      expect(Buffer.byteLength(atLimit)).toBe(MAX_BODY_BYTES);

      const ok = await t.app.inject(signedRequest(source, { body: atLimit }));
      const tooLarge = await t.app.inject(signedRequest(source, { body: overLimit }));

      expect(ok.statusCode).toBe(202);
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json<ErrorResponse>().error).toMatchObject({
        code: 'PAYLOAD_TOO_LARGE',
        message: `Body exceeds ${MAX_BODY_BYTES} bytes.`,
      });
    });

    it.each(['text/plain', 'application/x-www-form-urlencoded', 'application/xml'])(
      'AC1.6 SEC-LIM-01 content type %s returns 415',
      async (contentType) => {
        const response = await t.app.inject(
          signedRequest(source, { headers: { 'content-type': contentType } }),
        );

        expect(response.statusCode).toBe(415);
        expect(response.json<ErrorResponse>().error).toMatchObject({
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: 'Only application/json is accepted.',
        });
      },
    );

    it('accepts application/json with a charset parameter', async () => {
      const response = await t.app.inject(
        signedRequest(source, { headers: { 'content-type': 'application/json; charset=utf-8' } }),
      );
      expect(response.statusCode).toBe(202);
    });

    it('AC1.6 SEC-LIM-01 invalid JSON returns 400', async () => {
      const response = await t.app.inject(signedRequest(source, { body: '{"broken": ' }));

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponse>().error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Request body is not valid JSON.',
      });
    });

    it('AC1.6 SEC-LIM-01 invalid UTF-8 returns 400', async () => {
      // {"a":"<0xFF>"}: valid JSON structure around a byte that is not valid UTF-8.
      const payload = Buffer.concat([
        Buffer.from('{"a":"'),
        Buffer.from([0xff]),
        Buffer.from('"}'),
      ]);
      const before = await eventCount(source.id);

      const response = await t.app.inject({
        method: 'POST',
        url: `/in/${source.slug}`,
        headers: { 'content-type': 'application/json' },
        payload,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponse>().error).toMatchObject({
        code: 'VALIDATION_ERROR',
        message: 'Request body is not valid UTF-8.',
      });
      expect(await eventCount(source.id)).toBe(before);
    });

    it('known limitation: a body with a __proto__ key is refused by the JSON parser (400)', async () => {
      const response = await t.app.inject(
        signedRequest(source, { body: '{"__proto__":{"admin":true}}' }),
      );

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponse>().error.code).toBe('VALIDATION_ERROR');
    });

    it('stores the body byte for byte, including whitespace and non-ASCII text', async () => {
      const body = '{ "name" : "Zoë — 東京",\n  "n": 1.50 }';

      const response = await t.app.inject(signedRequest(source, { body }));

      expect(response.statusCode).toBe(202);
      const event = await t.prisma.event.findUniqueOrThrow({
        where: { id: response.json<IngestResponse>().id },
      });
      expect(Buffer.from(event.body, 'utf8').equals(Buffer.from(body, 'utf8'))).toBe(true);
      expect(event.bodyBytes).toBe(Buffer.byteLength(body));
    });

    it('stores headers lowercased with credentials redacted', async () => {
      const request = signedRequest(source, {
        headers: {
          Authorization: 'Bearer SUPERSECRETTOKEN',
          Cookie: 'session=SESSIONVALUE',
          'X-Custom': 'kept',
          'x-long': 'y'.repeat(10_000),
        },
      });
      const signature = request.headers['webhook-signature'];

      const response = await t.app.inject(request);

      const event = await t.prisma.event.findUniqueOrThrow({
        where: { id: response.json<IngestResponse>().id },
      });
      const headers = event.headers as Record<string, string>;
      expect(headers).toMatchObject({
        authorization: '[redacted]',
        cookie: '[redacted]',
        'webhook-signature': '[redacted]',
        'x-custom': 'kept',
        'webhook-id': request.headers['webhook-id'],
      });
      expect(headers['x-long']).toHaveLength(8192);
      const stored = JSON.stringify(event);
      expect(stored).not.toContain('SUPERSECRETTOKEN');
      expect(stored).not.toContain('SESSIONVALUE');
      expect(stored).not.toContain(signature);
    });
  });

  describe('M2: inbound signature verification', () => {
    const expectInvalidSignature = (response: { statusCode: number; json: () => unknown }) => {
      expect(response.statusCode).toBe(401);
      expect((response.json() as ErrorResponse).error).toMatchObject({
        code: 'INVALID_SIGNATURE',
        // The same message for every cause: the response must not say which check failed.
        message: 'Signature verification failed.',
      });
    };

    it('AC2.1 a wrong signature returns 401 INVALID_SIGNATURE', async () => {
      const wrong = `v1,${Buffer.alloc(32, 7).toString('base64')}`;
      expectInvalidSignature(
        await t.app.inject(signedRequest(source, { headers: { 'webhook-signature': wrong } })),
      );
    });

    it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])(
      'AC2.1 a missing %s header returns 401',
      async (header) => {
        expectInvalidSignature(
          await t.app.inject(signedRequest(source, { headers: { [header]: undefined } })),
        );
      },
    );

    it('AC2.1 a timestamp outside the tolerance returns 401, in both directions', async () => {
      const now = Math.floor(Date.now() / 1000);
      const tolerance = t.env.SIGNATURE_TOLERANCE_SECONDS;

      expectInvalidSignature(
        await t.app.inject(signedRequest(source, { timestampSeconds: now - tolerance - 30 })),
      );
      expectInvalidSignature(
        await t.app.inject(signedRequest(source, { timestampSeconds: now + tolerance + 30 })),
      );
    });

    it('AC2.2 generic-hmac reads the configured header, prefix and encoding', async () => {
      const github = await tenant.addSource({
        config: {
          mode: 'generic-hmac',
          signatureHeader: 'x-hub-signature-256',
          signaturePrefix: 'sha256=',
          signatureEncoding: 'hex',
        },
        secret: 'my-github-webhook-secret',
      });
      const post = (signature: string) =>
        t.app.inject({
          method: 'POST',
          url: `/in/${github.slug}`,
          headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
          payload: SAMPLE_BODY,
        });
      const good = signGenericHmac({
        secret: 'my-github-webhook-secret',
        body: SAMPLE_BODY,
        encoding: 'hex',
        prefix: 'sha256=',
      });

      const accepted = await post(good);
      expect(accepted.statusCode).toBe(202);
      expectInvalidSignature(await post(good.replace('sha256=', '')));
      expectInvalidSignature(await post(`sha256=${'0'.repeat(64)}`));

      // The source's own signature header is a credential too: it must be stored redacted.
      const event = await t.prisma.event.findUniqueOrThrow({
        where: { id: accepted.json<IngestResponse>().id },
      });
      expect((event.headers as Record<string, string>)['x-hub-signature-256']).toBe('[redacted]');
    });

    it('AC2.2 generic-hmac with a timestamp header enforces the tolerance window', async () => {
      const secret = 'timestamped-secret';
      const withTimestamp = await tenant.addSource({
        config: {
          mode: 'generic-hmac',
          signatureHeader: 'x-signature',
          signatureEncoding: 'base64',
          timestampHeader: 'x-timestamp',
        },
        secret,
      });
      const post = (timestampSeconds: number) =>
        t.app.inject({
          method: 'POST',
          url: `/in/${withTimestamp.slug}`,
          headers: {
            'content-type': 'application/json',
            'x-timestamp': String(timestampSeconds),
            'x-signature': signGenericHmac({
              secret,
              body: SAMPLE_BODY,
              encoding: 'base64',
              timestampSeconds,
            }),
          },
          payload: SAMPLE_BODY,
        });
      const now = Math.floor(Date.now() / 1000);

      expect((await post(now)).statusCode).toBe(202);
      expectInvalidSignature(await post(now - t.env.SIGNATURE_TOLERANCE_SECONDS - 30));
    });

    it('a source in mode none accepts an unsigned request', async () => {
      const open = await tenant.addSource({ config: { mode: 'none' } });

      const response = await t.app.inject({
        method: 'POST',
        url: `/in/${open.slug}`,
        headers: { 'content-type': 'application/json' },
        payload: SAMPLE_BODY,
      });

      expect(response.statusCode).toBe(202);
    });

    it('AC2.3 SEC-IN-11 the signature is checked against the raw bytes, not the parsed JSON', async () => {
      // Sign {"a":1} but send { "a": 1 }: the same JSON value, different bytes.
      const request = signedRequest(source, { body: '{"a":1}' });

      const response = await t.app.inject({ ...request, payload: '{ "a": 1 }' });

      expectInvalidSignature(response);
    });

    it('AC2.5 SEC-IN-12 a rejected request creates no Event row and no job', async () => {
      const fresh = await tenant.addSource();
      const jobsBefore = await jobCount();

      const response = await t.app.inject(
        signedRequest(fresh, { headers: { 'webhook-signature': 'v1,AAAA' } }),
      );

      expectInvalidSignature(response);
      expect(await eventCount(fresh.id)).toBe(0);
      expect(await jobCount()).toBe(jobsBefore);
    });

    it('SEC-IN-13 accepts a signature produced by the official standardwebhooks package', async () => {
      const id = `msg_${randomUUID()}`;
      const now = new Date();
      const signature = new Webhook(source.secret!).sign(id, now, SAMPLE_BODY);

      const response = await t.app.inject({
        method: 'POST',
        url: `/in/${source.slug}`,
        headers: {
          'content-type': 'application/json',
          'webhook-id': id,
          'webhook-timestamp': String(Math.floor(now.getTime() / 1000)),
          'webhook-signature': signature,
        },
        payload: SAMPLE_BODY,
      });

      expect(response.statusCode).toBe(202);
    });
  });

  describe('M3: inbound deduplication', () => {
    it('AC3.1 the same external id twice gives one Event; the second is 202 duplicate with the first id', async () => {
      const fresh = await tenant.addSource();
      const id = `msg_${randomUUID()}`;

      const first = await t.app.inject(signedRequest(fresh, { id }));
      const second = await t.app.inject(signedRequest(fresh, { id }));

      expect(first.statusCode).toBe(202);
      expect(second.statusCode).toBe(202);
      const firstBody = first.json<IngestResponse>();
      expect(firstBody.status).toBe('accepted');
      expect(second.json<IngestResponse>()).toEqual({ id: firstBody.id, status: 'duplicate' });
      expect(await eventCount(fresh.id)).toBe(1);
    });

    it('AC3.1 ten concurrent copies of one webhook still give one Event', async () => {
      const fresh = await tenant.addSource();
      const request = signedRequest(fresh, { id: `msg_${randomUUID()}` });

      const responses = await Promise.all(Array.from({ length: 10 }, () => t.app.inject(request)));

      const bodies = responses.map((r) => r.json<IngestResponse>());
      expect(responses.every((r) => r.statusCode === 202)).toBe(true);
      expect(bodies.filter((b) => b.status === 'accepted')).toHaveLength(1);
      expect(new Set(bodies.map((b) => b.id)).size).toBe(1);
      expect(await eventCount(fresh.id)).toBe(1);
    });

    it('AC3.2 requests without an external event id are never deduplicated', async () => {
      const noDedupe = await tenant.addSource({ config: { mode: 'none' } });
      const post = () =>
        t.app.inject({
          method: 'POST',
          url: `/in/${noDedupe.slug}`,
          headers: { 'content-type': 'application/json' },
          payload: SAMPLE_BODY,
        });

      const first = (await post()).json<IngestResponse>();
      const second = (await post()).json<IngestResponse>();

      expect(first.status).toBe('accepted');
      expect(second.status).toBe('accepted');
      expect(second.id).not.toBe(first.id);
      expect(await eventCount(noDedupe.id)).toBe(2);
    });

    it('AC3.3 the same external id on two sources gives two events', async () => {
      const sourceA = await tenant.addSource();
      const sourceB = await tenant.addSource();
      const id = `msg_${randomUUID()}`;

      const a = (await t.app.inject(signedRequest(sourceA, { id }))).json<IngestResponse>();
      const b = (await t.app.inject(signedRequest(sourceB, { id }))).json<IngestResponse>();

      expect(a.status).toBe('accepted');
      expect(b.status).toBe('accepted');
      expect(b.id).not.toBe(a.id);
    });

    it('cuts an external event id at 255 characters', async () => {
      const fresh = await tenant.addSource();

      const response = await t.app.inject(signedRequest(fresh, { id: 'x'.repeat(300) }));

      expect(response.statusCode).toBe(202);
      const event = await t.prisma.event.findUniqueOrThrow({
        where: { id: response.json<IngestResponse>().id },
      });
      expect(event.externalEventId).toBe('x'.repeat(255));
    });
  });

  describe('M16: secrets at rest', () => {
    it('AC16.1 the source secret is stored as an AES-256-GCM envelope, never as plaintext', async () => {
      const row = await t.prisma.source.findUniqueOrThrow({ where: { id: source.id } });

      expect(row.secretEnc).toMatch(/^v1:k1:/);
      expect(JSON.stringify(row)).not.toContain(source.secret);
      // The envelope really is the secret: it decrypts to it, and ingestion verifies with it.
      const masterKey = parseMasterKey(t.env.SECRETS_MASTER_KEY);
      expect(
        decryptSecret(row.secretEnc!, masterKey, { tenantId: tenant.id, purpose: 'source-secret' }),
      ).toBe(source.secret);
      expect((await t.app.inject(signedRequest(source))).statusCode).toBe(202);
    });

    it('AC16.2 a tampered ciphertext makes decryption fail: nothing is accepted', async () => {
      const victim = await tenant.addSource();
      const row = await t.prisma.source.findUniqueOrThrow({ where: { id: victim.id } });
      const parts = row.secretEnc!.split(':');
      const ciphertext = Buffer.from(parts[3]!, 'base64');
      ciphertext[0] = ciphertext[0]! ^ 1;
      parts[3] = ciphertext.toString('base64');
      await t.prisma.source.update({
        where: { id: victim.id },
        data: { secretEnc: parts.join(':') },
      });
      t.app.get(SourceCache).clear();

      const response = await t.app.inject(signedRequest(victim));

      expect(response.statusCode).toBe(500);
      expect(response.json<ErrorResponse>().error.code).toBe('INTERNAL');
      expect(await eventCount(victim.id)).toBe(0);
    });

    it("AC16.2 a ciphertext moved to another tenant's row makes decryption fail", async () => {
      const original = await tenant.addSource();
      const target = await otherTenant.addSource();
      const row = await t.prisma.source.findUniqueOrThrow({ where: { id: original.id } });
      await t.prisma.source.update({
        where: { id: target.id },
        data: { secretEnc: row.secretEnc },
      });
      t.app.get(SourceCache).clear();

      // Signed with the secret that the copied ciphertext holds. Without the AAD this would pass.
      const response = await t.app.inject(signedRequest({ ...target, secret: original.secret }));

      expect(response.statusCode).toBe(500);
      expect(await eventCount(target.id)).toBe(0);
    });
  });
});
