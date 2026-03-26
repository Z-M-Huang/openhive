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

// Transient errors that should not crash the server
const SURVIVABLE_CODES = new Set([
  'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
]);

process.on('uncaughtException', (err) => {
  const code = 'code' in err ? (err as { code?: string }).code : undefined;
  if (code && SURVIVABLE_CODES.has(code)) {
    // eslint-disable-next-line no-console
    console.error(`Transient error (survived): ${code} — ${err.message}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Uncaught exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  const code = 'code' in err ? (err as { code?: string }).code : undefined;
  if (code && SURVIVABLE_CODES.has(code)) {
    // eslint-disable-next-line no-console
    console.error(`Transient rejection (survived): ${code} — ${err.message}`);
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

bootstrap()
  .then((result) => { shutdownFn = result.shutdown; })
  .catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error('Fatal: bootstrap failed', err);
    process.exit(1);
  });
