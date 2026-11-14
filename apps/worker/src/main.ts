// Entry point of the worker process: read the configuration, start the worker, and shut it down
// cleanly when the process is told to stop. Everything else is in worker-app.ts, which the
// integration tests share.
import { loadDotEnvFile, parseEnv } from '@hdl/core';
import { startWorker } from './worker-app.js';

// Local development reads the repository's .env. In production the platform sets the variables.
loadDotEnvFile();
// Throws, and so stops the process, if a variable is missing or SECRETS_MASTER_KEY is not 32 bytes.
const env = parseEnv();

const worker = await startWorker(env);

// SIGTERM is what a container platform sends before it kills the process. Windows never delivers
// SIGTERM to Node; Ctrl+C in a terminal sends SIGINT. So both are handled, each at most once:
// a second Ctrl+C during the wait does not start a second shutdown.
// See docs/QUEUES.md#graceful-shutdown
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    worker.ctx.logger.info({ signal }, 'Signal received');
    worker
      .shutdown()
      .catch((error: unknown) => {
        worker.ctx.logger.error({ err: error }, 'Shutdown failed');
        process.exitCode = 1;
      })
      // 5. Exit explicitly: a timer or socket left behind by a library must not keep us alive.
      .finally(() => process.exit());
  });
}
