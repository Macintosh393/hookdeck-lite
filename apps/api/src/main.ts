// Entry point of the api process: read the configuration, build the app, listen.
// Everything interesting is in create-app.ts, which the tests share.
import { loadDotEnvFile, parseEnv } from '@hdl/core';
import { createApp } from './create-app.js';

// Local development reads the repository's .env. In production the platform sets the variables.
loadDotEnvFile();
// Throws, and so stops the process, if a variable is missing or SECRETS_MASTER_KEY is not 32 bytes.
const env = parseEnv();

const app = await createApp(env);
// 0.0.0.0, not localhost: inside a container, localhost is not reachable from outside it.
await app.listen(env.PORT, '0.0.0.0');
