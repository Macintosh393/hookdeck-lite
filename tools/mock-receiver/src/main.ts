// Runs the mock receiver as a process: `pnpm --filter @hdl/mock-receiver start:watch`, or the
// docker-compose service. It listens on MOCK_RECEIVER_PORT (default 4000) on every interface, so
// a container port mapping works. MOCK_FAIL_RATE and MOCK_LATENCY_MS add chaos for demos.
import { createMockReceiver } from './index.js';

/** Reads a numeric environment variable, or exits with a message when it is out of range. */
function numberFromEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    console.error(`${name} must be a number between ${min} and ${max}`);
    process.exit(1);
  }
  return value;
}

const port = numberFromEnv('MOCK_RECEIVER_PORT', 4000, 0, 65_535);
if (!Number.isInteger(port)) {
  console.error('MOCK_RECEIVER_PORT must be a port number');
  process.exit(1);
}
const failRate = numberFromEnv('MOCK_FAIL_RATE', 0, 0, 1);
const latencyMs = numberFromEnv('MOCK_LATENCY_MS', 0, 0, 60_000);

const receiver = await createMockReceiver({ failRate, latencyMs }).listen(port, '0.0.0.0');
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    msg: 'mock receiver listening',
    port: receiver.port,
    failRate,
    latencyMs,
  }),
);

// Containers get SIGTERM; Ctrl+C on Windows sends SIGINT. Handle both (docs/QUEUES.md#graceful-shutdown).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void receiver.close().finally(() => process.exit(0));
  });
}
