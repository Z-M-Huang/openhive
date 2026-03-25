/**
 * Process entrypoint — bootstraps OpenHive and registers signal/error handlers.
 *
 * This file is the production entry (`node dist/entrypoint.js`).
 * Tests import from `index.ts` directly, which has no side effects.
 */

import { bootstrap } from './index.js';

let shutdownFn: (() => Promise<void>) | undefined;

const handleSignal = (): void => {
  if (shutdownFn) {
    void shutdownFn().then(() => process.exit(0));
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', handleSignal);
process.on('SIGINT', handleSignal);

// Prevent SDK subprocess EPIPE from crashing the server
process.on('uncaughtException', (err) => {
  if ('code' in err && err.code === 'EPIPE') return;
  // eslint-disable-next-line no-console
  console.error('Uncaught exception:', err);
  process.exit(1);
});

bootstrap()
  .then((result) => { shutdownFn = result.shutdown; })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Fatal: bootstrap failed', err);
    process.exit(1);
  });
