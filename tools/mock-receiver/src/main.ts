// Runs the mock receiver as a process: `pnpm dev` here, or the docker-compose service.
// It listens on MOCK_RECEIVER_PORT (default 4000) on every interface, so a container port mapping works.
import { createMockReceiver } from './index.js';

const port = Number(process.env.MOCK_RECEIVER_PORT ?? '4000');
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  console.error('MOCK_RECEIVER_PORT must be a port number');
  process.exit(1);
}

const receiver = await createMockReceiver().listen(port, '0.0.0.0');
console.log(
  JSON.stringify({
    time: new Date().toISOString(),
    msg: 'mock receiver listening',
    port: receiver.port,
  }),
);

// Containers get SIGTERM; Ctrl+C on Windows sends SIGINT. Handle both (docs/QUEUES.md#graceful-shutdown).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void receiver.close().finally(() => process.exit(0));
  });
}
