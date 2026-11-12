// Helpers shared by the integration tests of @hdl/core.
import { createServer } from 'node:net';
import { Writable } from 'node:stream';
import { createLogger } from '../src/logger.js';

export const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/1';

/**
 * A Redis URL that points at a port nothing listens on. It simulates "Redis is down" without
 * stopping the shared container, which would break every other test file running in parallel.
 */
export async function closedPortRedisUrl(): Promise<string> {
  const port = await new Promise<number>((resolve, reject) => {
    // Ask the OS for a free port, then release it again.
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const freePort = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(freePort));
    });
  });
  return `redis://127.0.0.1:${port}/0`;
}

/** A logger that keeps its lines in memory, so a test can assert on what was logged. */
export function captureLogger() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'debug', name: 'test', destination });
  const lines = () =>
    chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { logger, lines };
}
