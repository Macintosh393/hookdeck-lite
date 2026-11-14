// Toolchain guard for two BullMQ 6 behaviours the worker's design depends on. Resolves the
// unverified items U8 and U9 in docs/PLAN.md. Like the U6 guard, it uses BullMQ directly, so a
// failure here points at the library (for example after an upgrade) and not at our code.
import { randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
const prefix = `${process.env.BULLMQ_PREFIX ?? 'hdl-test'}-${randomUUID().slice(0, 8)}`;

/** Polls until `check` returns a value. BullMQ's timing lives in Redis, so tests cannot use fake timers. */
async function eventually<T>(check: () => Promise<T | undefined | false>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Condition not met within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('BullMQ 6 behaviour the worker relies on', () => {
  let producerConnection: Redis;
  let workerConnection: Redis;
  const queues: Queue[] = [];
  const workers: Array<{ close(): Promise<void> }> = [];

  const newQueue = (name: string) => {
    const queue = new Queue(name, { connection: producerConnection, prefix });
    queues.push(queue);
    return queue;
  };

  beforeAll(() => {
    producerConnection = new Redis(redisUrl);
    workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  });

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.close()));
    for (const queue of queues) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await producerConnection.quit();
    await workerConnection.quit();
  });

  it('U8: the worker `failed` listener fires on every failed attempt, not only the last', async () => {
    const queue = newQueue('u8-failed-per-attempt');
    const seen: Array<{ attemptsMade: number; attempts: number | undefined; prev: string }> = [];

    const worker = new Worker(queue.name, () => Promise.reject(new Error('always fails')), {
      connection: workerConnection,
      prefix,
    });
    workers.push(worker);
    worker.on('failed', (job: Job | undefined, _error: Error, prev: string) => {
      if (job) seen.push({ attemptsMade: job.attemptsMade, attempts: job.opts.attempts, prev });
    });

    await queue.add('job', {}, { attempts: 3, backoff: { type: 'fixed', delay: 10 } });
    await eventually(() => Promise.resolve(seen.length >= 3));

    // One event per attempt. Only the last has attemptsMade >= attempts: that is how a listener
    // tells "will be retried" from "will not run again".
    expect(seen.map((entry) => entry.attemptsMade)).toEqual([1, 2, 3]);
    expect(seen.every((entry) => entry.attempts === 3)).toBe(true);
    expect(seen.every((entry) => entry.prev === 'active')).toBe(true);
    expect(await queue.getFailedCount()).toBe(1);
  });

  it('U8: an UnrecoverableError fails the job once, with attempts left', async () => {
    const queue = newQueue('u8-unrecoverable');
    const seen: Array<{ attemptsMade: number; unrecoverable: boolean }> = [];

    const worker = new Worker(
      queue.name,
      () => Promise.reject(new UnrecoverableError('permanent')),
      { connection: workerConnection, prefix },
    );
    workers.push(worker);
    worker.on('failed', (job, error) => {
      if (job) {
        seen.push({
          attemptsMade: job.attemptsMade,
          unrecoverable: error instanceof UnrecoverableError,
        });
      }
    });

    const job = await queue.add('job', {}, { attempts: 5, backoff: { type: 'fixed', delay: 10 } });
    await eventually(async () => (await job.getState()) === 'failed');

    // attemptsMade (1) is below attempts (5), so the listener must also check the error type.
    expect(seen).toEqual([{ attemptsMade: 1, unrecoverable: true }]);
  });

  it('U8: the custom backoff strategy receives the error the processor threw', async () => {
    const queue = newQueue('u8-backoff-strategy');
    const strategyCalls: Array<{
      attemptsMade: number;
      type: string | undefined;
      message: string;
    }> = [];
    let runs = 0;

    const worker = new Worker(
      queue.name,
      () => {
        runs += 1;
        return runs < 3 ? Promise.reject(new Error(`fail ${runs}`)) : Promise.resolve('done');
      },
      {
        connection: workerConnection,
        prefix,
        settings: {
          backoffStrategy: (attemptsMade, type, error) => {
            strategyCalls.push({ attemptsMade, type, message: error?.message ?? '' });
            return 10;
          },
        },
      },
    );
    workers.push(worker);

    const job = await queue.add('job', {}, { attempts: 5, backoff: { type: 'custom' } });
    await eventually(async () => (await job.getState()) === 'completed');

    expect(strategyCalls).toEqual([
      { attemptsMade: 1, type: 'custom', message: 'fail 1' },
      { attemptsMade: 2, type: 'custom', message: 'fail 2' },
    ]);
  });

  it('U9: an add with the jobId of a completed job is ignored until that job is removed', async () => {
    const queue = newQueue('u9-completed');
    const jobId = randomUUID();
    let runs = 0;

    const worker = new Worker(
      queue.name,
      () => {
        runs += 1;
        return Promise.resolve('ok');
      },
      { connection: workerConnection, prefix },
    );
    workers.push(worker);

    const first = await queue.add('job', { n: 1 }, { jobId });
    await eventually(async () => (await first.getState()) === 'completed');

    await queue.add('job', { n: 2 }, { jobId });
    // Give a wrongly accepted second job the chance to run before asserting that none did.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(runs).toBe(1);
    expect((await queue.getJob(jobId))?.data).toEqual({ n: 1 });
    expect(await queue.getJobCounts('waiting', 'active', 'delayed')).toEqual({
      waiting: 0,
      active: 0,
      delayed: 0,
    });

    // Once the finished job is removed, the same id is accepted again.
    await (await queue.getJob(jobId))?.remove();
    await queue.add('job', { n: 3 }, { jobId });
    await eventually(() => Promise.resolve(runs === 2));
  });

  it('U9: an add with the jobId of a failed job is ignored too', async () => {
    const queue = newQueue('u9-failed');
    const jobId = randomUUID();
    let runs = 0;

    const worker = new Worker(
      queue.name,
      () => {
        runs += 1;
        return Promise.reject(new Error('boom'));
      },
      { connection: workerConnection, prefix },
    );
    workers.push(worker);

    const first = await queue.add('job', { n: 1 }, { jobId, attempts: 1 });
    await eventually(async () => (await first.getState()) === 'failed');

    await queue.add('job', { n: 2 }, { jobId, attempts: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(runs).toBe(1);
    expect(await (await queue.getJob(jobId))?.getState()).toBe('failed');
  });
});
