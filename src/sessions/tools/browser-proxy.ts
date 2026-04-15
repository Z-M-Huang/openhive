/**
 * BrowserRelay — manages the @playwright/mcp browser backend lifecycle.
 *
 * Lazily spawns a playwright child process via StdioClientTransport,
 * reuses the connection for subsequent calls, and auto-closes after
 * an idle TTL (default 5 minutes).
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import { join, dirname } from 'node:path';
import { readdirSync, existsSync } from 'node:fs';

export interface BrowserRelay {
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  getToolNames(): string[];
  close(): Promise<void>;
  readonly available: boolean;
}

export interface BrowserRelayOpts {
  readonly logger: { info(msg: string, meta?: Record<string, unknown>): void };
  readonly idleTtlMs?: number;
}

const DEFAULT_IDLE_TTL_MS = 300_000; // 5 minutes

/** Find Playwright-bundled Chromium binary from PLAYWRIGHT_BROWSERS_PATH. */
function findChromiumPath(): string | undefined {
  const browsersDir = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!browsersDir || !existsSync(browsersDir)) return undefined;
  try {
    const chromiumDir = readdirSync(browsersDir).find((d) => d.startsWith('chromium-'));
    if (!chromiumDir) return undefined;
    const candidate = join(browsersDir, chromiumDir, 'chrome-linux64', 'chrome');
    return existsSync(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Create a BrowserRelay that connects to @playwright/mcp via stdio.
 *
 * Resolves the playwright-mcp CLI binary, spawns it, enumerates available
 * tools, and returns the relay. Throws if @playwright/mcp is not installed.
 */
export async function createBrowserRelay(opts: BrowserRelayOpts): Promise<BrowserRelay> {
  const { logger, idleTtlMs = DEFAULT_IDLE_TTL_MS } = opts;

  // Resolve playwright-mcp binary path.
  // @playwright/mcp exports only '.' in its package.json exports map,
  // so we resolve the package root and find cli.js relative to it.
  const require = createRequire(import.meta.url);
  let mcpCliPath: string;
  try {
    const pkgPath = require.resolve('@playwright/mcp/package.json');
    mcpCliPath = join(dirname(pkgPath), 'cli.js');
  } catch {
    throw new Error(
      'Browser relay failed to initialize — please update to the latest OpenHive version',
    );
  }

  let client: Client | null = null;
  let transport: StdioClientTransport | null = null;
  let toolNames: string[] = [];
  let lastUsedAt = Date.now();
  let closed = false;

  async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer!);
    }
  }

  async function connect(): Promise<Client> {
    if (client) return client;

    const cliArgs = [mcpCliPath, '--headless', '--no-sandbox'];
    const chromiumPath = findChromiumPath();
    if (chromiumPath) cliArgs.push('--executable-path', chromiumPath);

    const t = new StdioClientTransport({
      command: process.execPath,
      args: cliArgs,
      stderr: 'ignore',
    });

    const c = new Client({ name: 'openhive-browser-relay', version: '1.0.0' });
    try {
      await withTimeout(c.connect(t), 2_000, 'browser relay connect');
      const { tools } = await withTimeout(c.listTools(), 5_000, 'listTools');
      toolNames = tools.map((tool) => tool.name);
    } catch (err) {
      // Kill child process on failure — fire-and-forget to avoid blocking
      t.close().catch(() => {});
      client = null;
      transport = null;
      throw err;
    }

    client = c;
    transport = t;
    lastUsedAt = Date.now();

    logger.info('Browser relay connected', { tools: toolNames.length });
    return client;
  }

  async function disconnect(): Promise<void> {
    if (transport) {
      try {
        await transport.close();
      } catch {
        // Ignore close errors — child process may already be dead
      }
    }
    client = null;
    transport = null;
  }

  // Initial connection to verify @playwright/mcp works and enumerate tools
  await connect();

  // Idle TTL: check periodically, close if no activity
  const idleTimer = setInterval(async () => {
    if (closed) return;
    if (client && Date.now() - lastUsedAt > idleTtlMs) {
      logger.info('Browser relay idle timeout — closing');
      await disconnect();
    }
  }, 60_000);
  idleTimer.unref();

  const relay: BrowserRelay = {
    get available() {
      return !closed;
    },

    getToolNames() {
      return [...toolNames];
    },

    async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
      if (closed) throw new Error('Browser relay is closed');
      const c = await connect();
      lastUsedAt = Date.now();
      const result = await c.callTool({ name: toolName, arguments: args });
      return result.content;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(idleTimer);
      await disconnect();
      logger.info('Browser relay closed');
    },
  };

  return relay;
}
