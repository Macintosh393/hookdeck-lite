// Unit tests for the promise time limit helper.
import { describe, expect, it } from 'vitest';
import { TimeoutError, withTimeout } from './with-timeout.js';

describe('withTimeout', () => {
  it('passes a result through when the promise settles in time', async () => {
    await expect(withTimeout(Promise.resolve('done'), 1000, 'op')).resolves.toBe('done');
  });

  it('passes a rejection through unchanged', async () => {
    const failure = new Error('boom');
    await expect(withTimeout(Promise.reject(failure), 1000, 'op')).rejects.toBe(failure);
  });

  it('rejects with a TimeoutError when the promise is too slow', async () => {
    const never = new Promise<void>(() => {});

    await expect(withTimeout(never, 20, 'slow op')).rejects.toBeInstanceOf(TimeoutError);
    await expect(withTimeout(never, 20, 'slow op')).rejects.toThrow(
      'slow op timed out after 20 ms',
    );
  });
});
