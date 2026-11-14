// Entry point of @hdl/core: the Node-only building blocks shared by the api, the worker and the
// scripts. It may import @hdl/shared but never @hdl/database (docs/ARCHITECTURE.md#components).
export * from './env.js';
export * from './logger.js';
export * from './redis.js';
export * from './queues/types.js';
export * from './queues/factories.js';
export * from './crypto/hmac.js';
export * from './crypto/secret-encryption.js';
export * from './crypto/api-key.js';
export * from './rate-limit/script.js';
export * from './rate-limit/limiter.js';
export * from './stream/publisher.js';
export * from './stream/subscriber.js';
export * from './delivery/backoff.js';
export * from './delivery/retry-after.js';
export * from './delivery/classify.js';
export * from './ssrf/address-check.js';
export * from './ssrf/resolve-target.js';
export * from './ssrf/safe-http-client.js';
export * from './util/with-timeout.js';

// Re-exported so the apps never depend on bullmq, ioredis or pino themselves: one package owns the
// versions of those libraries, and there is exactly one copy of each class at runtime (which
// `instanceof UnrecoverableError` relies on).
export { UnrecoverableError, Worker } from 'bullmq';
export type { Job, Queue } from 'bullmq';
export type { Redis } from 'ioredis';
export type { Logger } from 'pino';
