// Unit tests for the backoff formula. The random source is injected, so every case is exact.
// The ceilings asserted here are the rows of the worked delay table in docs/QUEUES.md#worked-delay-table.
import { describe, expect, it } from 'vitest';
import { backoffCeiling, computeBackoffDelay } from './backoff.js';

const DEFAULTS = { baseMs: 30_000, capMs: 3_600_000 };
/** The largest value Math.random can return: the delay lands just under the ceiling. */
const ALMOST_ONE = (): number => 0.999_999_999;
const SECOND = 1000;
const MINUTE = 60 * SECOND;

describe('computeBackoffDelay', () => {
  // [failed attempt, ceiling]: the "Ceiling" column of the worked delay table, defaults profile.
  const workedTable: Array<[number, number]> = [
    [1, 30 * SECOND],
    [2, 1 * MINUTE],
    [3, 2 * MINUTE],
    [4, 4 * MINUTE],
    [5, 8 * MINUTE],
    [6, 16 * MINUTE],
    [7, 32 * MINUTE],
    [8, 60 * MINUTE], // 64 min, capped at 1 h
    [9, 60 * MINUTE], // capped
  ];

  it.each(workedTable)(
    'AC7.5 after failed attempt %i the ceiling is exactly %i ms',
    (attemptNumber, ceiling) => {
      expect(backoffCeiling(attemptNumber, DEFAULTS.baseMs, DEFAULTS.capMs)).toBe(ceiling);

      // random -> 0.999…: the delay is the last whole millisecond below the ceiling.
      const delay = computeBackoffDelay({
        attemptNumber,
        retryAfterMs: null,
        ...DEFAULTS,
        random: ALMOST_ONE,
      });
      expect(delay).toBe(ceiling - 1);
    },
  );

  it('the worst-case total wait of the default profile is 3 h 3 min 30 s (NFR3)', () => {
    let total = 0;
    for (let attempt = 1; attempt <= 9; attempt++) {
      total += backoffCeiling(attempt, DEFAULTS.baseMs, DEFAULTS.capMs);
    }
    expect(total).toBe(3 * 3_600_000 + 3 * MINUTE + 30 * SECOND);
  });

  it('the integration profile waits at most 140 ms in total (20 + 40 + 80)', () => {
    const ceilings = [1, 2, 3].map((attempt) => backoffCeiling(attempt, 20, 200));
    expect(ceilings).toEqual([20, 40, 80]);
    expect(backoffCeiling(5, 20, 200)).toBe(200);
  });

  it('is zero when the random source returns 0 (full jitter starts at zero)', () => {
    expect(
      computeBackoffDelay({ attemptNumber: 4, retryAfterMs: null, ...DEFAULTS, random: () => 0 }),
    ).toBe(0);
  });

  it('is half the ceiling when the random source returns 0.5', () => {
    expect(
      computeBackoffDelay({ attemptNumber: 3, retryAfterMs: null, ...DEFAULTS, random: () => 0.5 }),
    ).toBe(MINUTE);
  });

  it('never exceeds the cap, however many attempts failed', () => {
    for (const attemptNumber of [10, 50, 2000]) {
      const delay = computeBackoffDelay({
        attemptNumber,
        retryAfterMs: null,
        ...DEFAULTS,
        random: ALMOST_ONE,
      });
      expect(delay).toBeLessThan(DEFAULTS.capMs);
      expect(delay).toBe(DEFAULTS.capMs - 1);
    }
  });

  it('uses Retry-After as a floor: the example of QUEUES.md (attempt 2, 41 s jitter, 300 s asked)', () => {
    const delay = computeBackoffDelay({
      attemptNumber: 2,
      retryAfterMs: 300 * SECOND,
      ...DEFAULTS,
      random: () => 41 / 60, // 41 s of a 60 s ceiling
    });
    expect(delay).toBe(300 * SECOND);
  });

  it('keeps the jittered delay when it is longer than Retry-After', () => {
    const delay = computeBackoffDelay({
      attemptNumber: 5,
      retryAfterMs: 2 * SECOND,
      ...DEFAULTS,
      random: () => 0.5,
    });
    expect(delay).toBe(4 * MINUTE);
  });

  it('caps Retry-After at BACKOFF_CAP_MS so a receiver cannot park a job (threat T15)', () => {
    const oneYearMs = 365 * 24 * 3_600_000;
    const delay = computeBackoffDelay({
      attemptNumber: 1,
      retryAfterMs: oneYearMs,
      ...DEFAULTS,
      random: () => 0,
    });
    expect(delay).toBe(DEFAULTS.capMs);
  });

  it('ignores a negative Retry-After and treats attempt numbers below 1 as 1', () => {
    expect(
      computeBackoffDelay({ attemptNumber: 1, retryAfterMs: -500, ...DEFAULTS, random: () => 0 }),
    ).toBe(0);
    expect(backoffCeiling(0, DEFAULTS.baseMs, DEFAULTS.capMs)).toBe(30 * SECOND);
    expect(backoffCeiling(-3, DEFAULTS.baseMs, DEFAULTS.capMs)).toBe(30 * SECOND);
  });

  it('uses Math.random when no random source is given, and stays inside the range', () => {
    for (let i = 0; i < 200; i++) {
      const delay = computeBackoffDelay({ attemptNumber: 2, retryAfterMs: null, ...DEFAULTS });
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThan(MINUTE);
      expect(Number.isInteger(delay)).toBe(true);
    }
  });
});
