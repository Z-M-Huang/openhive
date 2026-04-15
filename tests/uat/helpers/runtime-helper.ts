/**
 * Runtime helpers for UAT scenarios.
 *
 * Provides utilities for spawning the application process and monitoring its health.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Options for spawning the application.
 */
export interface SpawnOptions {
  /** Run directory (defaults to temp directory) */
  runDir?: string;
  /** Data directory (defaults to runDir/data) */
  dataDir?: string;
  /** Port for HTTP server (defaults to 8080) */
  port?: number;
  /** Timeout for health check in ms (defaults to 30000) */
  healthTimeout?: number;
  /** Skip listening (for tests that don't need HTTP) */
  skipListen?: boolean;
}

/**
 * Result from spawnApp.
 */
export interface SpawnedApp {
  /** The child process */
  proc: ChildProcess | null;
  /** Collected stdout lines */
  stdout: string[];
  /** Collected stderr lines */
  stderr: string[];
  /** Wait for health endpoint to be ready */
  waitForHealth: () => Promise<boolean>;
  /** Stop the process */
  stop: () => void;
  /** The run directory path */
  runDir: string;
  /** The data directory path */
  dataDir: string;
}

/**
 * Spawn the OpenHive application process.
 * Returns helpers to monitor and control it.
 */
export function spawnApp(opts?: SpawnOptions): SpawnedApp {
  const runDir = opts?.runDir ?? mkdtempSync(join(tmpdir(), 'openhive-uat-'));
  const dataDir = opts?.dataDir ?? join(runDir, 'data');
  const port = opts?.port ?? 8080;
  const healthTimeout = opts?.healthTimeout ?? 30_000;

  const stdout: string[] = [];
  const stderr: string[] = [];

  // For skipListen mode, we don't actually spawn a process
  // Tests can use bootstrap() directly in Node context
  let proc: ChildProcess | null = null;

  if (!opts?.skipListen) {
    proc = spawn('node', ['dist/entrypoint.js'], {
      cwd: process.cwd(),
      env: {
        NODE_ENV: process.env.NODE_ENV ?? 'test',
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        OPENHIVE_RUN_DIR: runDir,
        OPENHIVE_DATA_DIR: dataDir,
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    proc.stdout?.on('data', (data) => {
      stdout.push(data.toString());
    });

    proc.stderr?.on('data', (data) => {
      stderr.push(data.toString());
    });
  }

  const waitForHealth = async (): Promise<boolean> => {
    if (opts?.skipListen) {
      // In skipListen mode, assume healthy immediately
      return true;
    }

    const startTime = Date.now();
    while (Date.now() - startTime < healthTimeout) {
      try {
        const response = await fetch(`http://localhost:${port}/health`);
        if (response.ok) {
          return true;
        }
      } catch {
        // Not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  };

  const stop = () => {
    if (proc) {
      proc.kill('SIGTERM');
    }
  };

  return {
    proc,
    stdout,
    stderr,
    waitForHealth,
    stop,
    runDir,
    dataDir,
  };
}

/**
 * Create a temporary directory for testing.
 */
export function createTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'openhive-uat-'));
}

/**
 * Clean up a temporary directory.
 */
export function cleanupTmpDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

/**
 * Run a npm script and capture output.
 */
export async function runNpmScript(script: string, timeout = 60_000): Promise<{
  success: boolean;
  stdout: string;
  stderr: string;
}> {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const proc = spawn('npm', ['run', script], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout?.on('data', (data) => {
    stdout.push(data.toString());
  });

  proc.stderr?.on('data', (data) => {
    stderr.push(data.toString());
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({
        success: false,
        stdout: stdout.join(''),
        stderr: stderr.join('') + '\nTimeout exceeded',
      });
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        success: code === 0,
        stdout: stdout.join(''),
        stderr: stderr.join(''),
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        success: false,
        stdout: stdout.join(''),
        stderr: stderr.join('') + '\n' + err.message,
      });
    });
  });
}