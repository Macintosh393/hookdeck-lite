// Unit tests for the logger factory: sensitive fields must be redacted wherever they appear.
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger, REDACTED } from './logger.js';

/** A logger that writes into memory, plus a way to read the lines back as objects. */
function captureLogger(level = 'info') {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level, name: 'test', destination });
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines, raw: () => chunks.join('') };
}

describe('createLogger', () => {
  it('writes JSON lines with the name and the bound fields', () => {
    const { logger, lines } = captureLogger();

    logger.child({ tenantId: 't1', eventId: 'e1' }).info('event stored');

    expect(lines()).toEqual([
      expect.objectContaining({ name: 'test', tenantId: 't1', eventId: 'e1', msg: 'event stored' }),
    ]);
  });

  it('redacts sensitive fields at the top level', () => {
    const { logger, raw } = captureLogger();

    logger.info(
      {
        secret: 'whsec_TOPSECRET',
        signingSecret: 'whsec_SIGNING',
        apiKey: 'hdl_demo1234_APIKEYVALUE',
        authorization: 'Bearer TOKENVALUE',
        'webhook-signature': 'v1,SIGNATUREVALUE',
        SECRETS_MASTER_KEY: 'MASTERKEYVALUE',
      },
      'top level',
    );

    for (const leaked of [
      'TOPSECRET',
      'SIGNING',
      'APIKEYVALUE',
      'TOKENVALUE',
      'SIGNATUREVALUE',
      'MASTERKEYVALUE',
    ]) {
      expect(raw()).not.toContain(leaked);
    }
    expect(raw()).toContain(REDACTED);
  });

  it('redacts sensitive headers one and two levels down', () => {
    const { logger, lines, raw } = captureLogger();

    logger.info(
      {
        headers: { cookie: 'session=COOKIEVALUE', 'content-type': 'application/json' },
        req: {
          headers: { authorization: 'Bearer NESTEDTOKEN', 'webhook-signature': 'v1,NESTEDSIG' },
        },
      },
      'nested',
    );

    expect(raw()).not.toContain('COOKIEVALUE');
    expect(raw()).not.toContain('NESTEDTOKEN');
    expect(raw()).not.toContain('NESTEDSIG');
    // Fields that are not sensitive stay readable.
    expect(lines()[0]).toMatchObject({ headers: { 'content-type': 'application/json' } });
  });

  it('logs nothing at level silent', () => {
    const { logger, raw } = captureLogger('silent');

    logger.error('should not appear');

    expect(raw()).toBe('');
  });
});
