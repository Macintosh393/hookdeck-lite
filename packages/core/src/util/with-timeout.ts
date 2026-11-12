// A small helper that puts a time limit on a promise. The api uses it around Redis and Postgres
// calls that must not make a webhook provider wait (rate limit, enqueue, publish, /ready).

export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Resolves or rejects like `promise`, unless `timeoutMs` passes first: then it rejects with a
 * TimeoutError. The original operation is not cancelled; its late result is ignored.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
