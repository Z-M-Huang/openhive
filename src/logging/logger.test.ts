/**
 * Tests for the AppLogger wrapper and the pino → LogStore pipeline.
 *
 * Unit tests: verify arg swapping with mock pino.
 * Integration test: verify metadata flows through real pino → tee → LogStore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { createLogger, wrapPinoLogger } from './logger.js';
import { withAudit } from '../sessions/tools/tool-audit.js';
import { createDatabase, createTables } from '../storage/database.js';
import { LogStore } from '../storage/stores/log-store.js';
import type { DatabaseInstance } from '../storage/database.js';

// ── Unit: wrapPinoLogger ─────────────────────────────────────────────────

describe('wrapPinoLogger()', () => {
  it('swaps (msg, meta) to pino (meta, msg) for info', () => {
    const fakePino = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
    const wrapped = wrapPinoLogger(fakePino as never);

    wrapped.info('PreToolUse', { tool: 'Read', params: { file: 'a.ts' } });

    expect(fakePino.info).toHaveBeenCalledWith(
      { tool: 'Read', params: { file: 'a.ts' } },
      'PreToolUse',
    );
  });

  it('swaps (msg, meta) to pino (meta, msg) for warn', () => {
    const fakePino = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
    const wrapped = wrapPinoLogger(fakePino as never);

    wrapped.warn('ToolFailed', { tool: 'Bash', error: 'EPIPE' });

    expect(fakePino.warn).toHaveBeenCalledWith(
      { tool: 'Bash', error: 'EPIPE' },
      'ToolFailed',
    );
  });

  it('swaps (msg, meta) to pino (meta, msg) for error', () => {
    const fakePino = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
    const wrapped = wrapPinoLogger(fakePino as never);

    wrapped.error('Critical failure', { code: 500 });

    expect(fakePino.error).toHaveBeenCalledWith(
      { code: 500 },
      'Critical failure',
    );
  });

  it('passes msg-only calls without meta object', () => {
    const fakePino = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
    const wrapped = wrapPinoLogger(fakePino as never);

    wrapped.info('Simple message');

    expect(fakePino.info).toHaveBeenCalledWith('Simple message');
  });

  it('wraps all six standard levels', () => {
    const fakePino = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), fatal: vi.fn() };
    const wrapped = wrapPinoLogger(fakePino as never);

    wrapped.trace('t');
    wrapped.debug('d');
    wrapped.info('i');
    wrapped.warn('w');
    wrapped.error('e');
    wrapped.fatal('f');

    expect(fakePino.trace).toHaveBeenCalledWith('t');
    expect(fakePino.debug).toHaveBeenCalledWith('d');
    expect(fakePino.info).toHaveBeenCalledWith('i');
    expect(fakePino.warn).toHaveBeenCalledWith('w');
    expect(fakePino.error).toHaveBeenCalledWith('e');
    expect(fakePino.fatal).toHaveBeenCalledWith('f');
  });
});

// ── Integration: createLogger → AppLogger → withAudit → LogStore ────────

describe('createLogger integration with LogStore', () => {
  let dbInstance: DatabaseInstance;
  let logStore: LogStore;

  beforeEach(() => {
    dbInstance = createDatabase(':memory:');
    createTables(dbInstance.raw);
    logStore = new LogStore(dbInstance.db);
  });

  afterEach(() => {
    dbInstance.raw.close();
  });

  it('ToolCall:start metadata reaches LogStore via withAudit', async () => {
    const logger = createLogger({ logStore, level: 'debug' });

    const execute = async (input: { file_path: string }) => ({ content: `data from ${input.file_path}` });
    const wrapped = withAudit('Read', execute, { logger });

    await wrapped({ file_path: '/tmp/test.ts' });

    // Flush pino (async tee stream)
    await new Promise((r) => setTimeout(r, 100));

    const entries = logStore.query({ limit: 10 });
    const startEntry = entries.find((e) => e.message === 'ToolCall:start');

    expect(startEntry).toBeDefined();
    expect(startEntry!.metadata).toBeDefined();
    expect(startEntry!.metadata!['tool']).toBe('Read');
    // Debug level emits inputSummary (truncated), not full params
    expect(startEntry!.metadata!['inputSummary']).toContain('file_path');
  });

  it('ToolCall:end metadata includes tool and durationMs', async () => {
    const logger = createLogger({ logStore, level: 'debug' });

    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- _input must be present so withAudit infers the right execute signature
    const execute = async (_input: Record<string, unknown>) => 'ok';
    const wrapped = withAudit('Bash', execute, { logger });

    await wrapped({});

    await new Promise((r) => setTimeout(r, 100));

    const entries = logStore.query({ limit: 10 });
    const endEntry = entries.find((e) => e.message === 'ToolCall:end');

    expect(endEntry).toBeDefined();
    expect(endEntry!.metadata).toBeDefined();
    expect(endEntry!.metadata!['tool']).toBe('Bash');
    expect(endEntry!.metadata!['durationMs']).toBeGreaterThanOrEqual(0);
  });

  it('bare pino call (wrong arg order) drops metadata — proves the bug we fixed', async () => {
    // Create a raw pino logger (bypassing our wrapper) to demonstrate the bug
    const rawPino = pino({ level: 'info' }, new (await import('node:stream')).Writable({
      write(chunk: Buffer | string, _enc, cb) {
        const line = typeof chunk === 'string' ? chunk : chunk.toString();
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          logStore.append({
            id: `log-bare-${Date.now()}`,
            level: 'info',
            message: typeof parsed['msg'] === 'string' ? parsed['msg'] : '',
            timestamp: Date.now(),
            source: 'test',
            metadata: parsed,
          });
        } catch { /* ignore */ }
        cb();
      },
    }));

    // Calling pino with (string, object) — the broken pattern
    rawPino.info('BareCall', { tool: 'Read' } as never);

    await new Promise((r) => setTimeout(r, 100));

    const entries = logStore.query({ limit: 10 });
    const bareEntry = entries.find((e) => e.message === 'BareCall');

    expect(bareEntry).toBeDefined();
    // Metadata should NOT contain 'tool' because pino drops the second arg when first is string
    expect(bareEntry!.metadata?.['tool']).toBeUndefined();
  });
});
