// Unit tests for parseRetryAfter: seconds, HTTP date, past date, garbage, negative, missing.
import { describe, expect, it } from 'vitest';
import { MAX_RETRY_AFTER_MS, parseRetryAfter } from './retry-after.js';

// A fixed "now": Wed, 21 Oct 2026 07:28:00 GMT.
const NOW = Date.UTC(2026, 9, 21, 7, 28, 0);

describe('parseRetryAfter', () => {
  it('parses a number of seconds', () => {
    expect(parseRetryAfter('120', NOW)).toBe(120_000);
    expect(parseRetryAfter('1', NOW)).toBe(1000);
    expect(parseRetryAfter(' 5 ', NOW)).toBe(5000);
  });

  it('parses zero seconds as zero, which asks for no extra wait', () => {
    expect(parseRetryAfter('0', NOW)).toBe(0);
  });

  it('parses an HTTP date in the future as the time until then', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:30:00 GMT', NOW)).toBe(120_000);
  });

  it('ignores an HTTP date in the past, and one that is exactly now', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:00:00 GMT', NOW)).toBeNull();
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', NOW)).toBeNull();
  });

  it.each(['soon', '12abc', '1.5', '1e3', '0x10', 'Wed, 99 Foo 2026 07:30:00 GMT', '2026-10-21'])(
    'ignores garbage: %s',
    (value) => {
      expect(parseRetryAfter(value, NOW)).toBeNull();
    },
  );

  it('ignores a negative number', () => {
    expect(parseRetryAfter('-5', NOW)).toBeNull();
  });

  it('ignores a missing or empty header', () => {
    expect(parseRetryAfter(undefined, NOW)).toBeNull();
    expect(parseRetryAfter(null, NOW)).toBeNull();
    expect(parseRetryAfter('', NOW)).toBeNull();
    expect(parseRetryAfter('   ', NOW)).toBeNull();
  });

  it('clamps an absurd value so it still fits a 32-bit database column', () => {
    expect(parseRetryAfter('99999999999', NOW)).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('Fri, 21 Oct 2126 07:28:00 GMT', NOW)).toBe(MAX_RETRY_AFTER_MS);
  });
});
