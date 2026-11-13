// Toolchain guard: BullMQ 6 working on top of ioredis 6 against the real Redis.
// Resolves unverified item U6 in docs/PLAN.md. It uses the two libraries directly, not our
// factories, so a failure here points at the libraries and not at our code.
import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/1';
// A unique prefix per test file keeps parallel test files out of each other's queues.
const prefix = `${process.env.BULLMQ_PREFIX ?? 'hdl-test'}-${randomUUID().slice(0, 8)}`;

describe('BullMQ 6 with ioredis 6 (U6)', () => {
  let producerConnection: Redis;
  let workerConnection: Redis;
  let queue: Queue<{ value: number }, number>;

  beforeAll(() => {
    producerConnection = new Redis(redisUrl);
    // BullMQ refuses a Worker connection unless maxRetriesPerRequest is null.
    workerConnection = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue('smoke', { connection: producerConnection, prefix });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await producerConnection.quit();
    await workerConnection.quit();
  });

  it('adds a job and a Worker processes it', async () => {
    const processed = new Promise<number>((resolve, reject) => {
      const worker = new Worker<{ value: number }, number>(
        'smoke',
        (job) => Promise.resolve(job.data.value * 2),
        { connection: workerConnection, prefix },
      );
      worker.on('completed', (_job, result) => {
        void worker.close().then(() => resolve(result));
      });
      worker.on('failed', (_job, error) => {
        void worker.close().then(() => reject(error));
      });
    });

    await queue.add('double', { value: 21 });

    await expect(processed).resolves.toBe(42);
  });

  it('ignores a second add with the same jobId while the first job exists', async () => {
    const jobId = randomUUID();

    await queue.add('double', { value: 1 }, { jobId });
    await queue.add('double', { value: 2 }, { jobId });

    const job = await queue.getJob(jobId);
    expect(job?.data).toEqual({ value: 1 });
    expect(await queue.getWaitingCount()).toBe(1);
  });
});
