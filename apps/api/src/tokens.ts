// Injection tokens for the things the api shares between modules: configuration and connections.
// NestJS finds a class provider by its type, but these are plain values and third-party objects,
// so they are registered under a symbol and requested with @Inject(TOKEN).

/** The parsed environment (`Env` from @hdl/core). */
export const ENV = Symbol('ENV');
/** The root pino logger. Request handlers make a child of it with the request's ids bound. */
export const LOGGER = Symbol('LOGGER');
/** The Prisma client. */
export const PRISMA = Symbol('PRISMA');
/** The fail-fast Redis connection (queues, rate limiter, publisher). */
export const REDIS = Symbol('REDIS');
/** The per-tenant rate limiter. */
export const RATE_LIMITER = Symbol('RATE_LIMITER');
/** SECRETS_MASTER_KEY decoded to its 32 bytes. */
export const MASTER_KEY = Symbol('MASTER_KEY');
