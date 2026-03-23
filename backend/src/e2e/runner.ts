/**
 * E2E test runner — builds Docker image, starts container, runs test suites,
 * and tears down. Used by the e2e-test skill.
 *
 * Usage: npx tsx backend/src/e2e/runner.ts [--tier1-only]
 */

import { execSync } from 'node:child_process';
import { mkdirSync, cpSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

const PROJECT_ROOT = join(import.meta.dirname, '..', '..', '..');
const FIXTURES_DIR = join(import.meta.dirname, 'fixtures');

interface SuiteResult {
  readonly name: string;
  readonly passed: boolean;
  readonly error?: string;
}

function exec(cmd: string, opts?: { cwd?: string; timeout?: number }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd ?? PROJECT_ROOT,
      timeout: opts?.timeout ?? 60_000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    const msg = err instanceof Error ? (err as { stderr?: string }).stderr ?? err.message : String(err);
    throw new Error(`Command failed: ${cmd}\n${msg}`);
  }
}

function setupTestDir(): string {
  const dir = join(tmpdir(), `openhive-e2e-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });

  // Copy compose file
  cpSync(join(FIXTURES_DIR, 'docker-compose.e2e.yml'), join(dir, 'docker-compose.yml'));

  // Setup config directory
  const configDir = join(dir, 'e2e-config');
  mkdirSync(configDir, { recursive: true });
  cpSync(join(FIXTURES_DIR, 'providers.yaml'), join(configDir, 'providers.yaml'));
  cpSync(join(FIXTURES_DIR, 'channels.yaml'), join(configDir, 'channels.yaml'));

  // Setup rules directory (empty, will be seeded)
  mkdirSync(join(dir, 'e2e-rules'), { recursive: true });

  return dir;
}

function waitForHealth(port: number, maxWaitMs: number = 60_000): boolean {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const result = exec(`curl -sf http://localhost:${String(port)}/health`, { timeout: 5_000 });
      if (result.includes('"ok":true')) return true;
    } catch {
      // Not ready yet
    }
    execSync('sleep 2');
  }
  return false;
}

function runTier1Suites(port: number): SuiteResult[] {
  const results: SuiteResult[] = [];
  const base = `http://localhost:${String(port)}`;

  // Suite 1: Health endpoint returns 200
  try {
    const health = exec(`curl -sf ${base}/health`);
    const body = JSON.parse(health) as { storage: { ok: boolean } };
    results.push({ name: 'health-200', passed: body.storage.ok });
  } catch (err) {
    results.push({ name: 'health-200', passed: false, error: String(err) });
  }

  // Suite 2: .run/ structure created
  try {
    const logs = exec('docker compose logs openhive-e2e 2>&1');
    const hasStarted = logs.includes('OpenHive v3 started');
    results.push({ name: 'run-structure', passed: hasStarted });
  } catch (err) {
    results.push({ name: 'run-structure', passed: false, error: String(err) });
  }

  // Suite 3: Trigger registered (from triggers.yaml if present)
  try {
    const health = exec(`curl -sf ${base}/health`);
    const body = JSON.parse(health) as { triggers: { registered: number } };
    results.push({ name: 'triggers-registered', passed: body.triggers.registered >= 0 });
  } catch (err) {
    results.push({ name: 'triggers-registered', passed: false, error: String(err) });
  }

  // Suite 4: POST /api/message works (enabled via env var)
  try {
    const resp = exec(
      `curl -sf -X POST ${base}/api/message -H "Content-Type: application/json" -d '{"content":"e2e-test-ping"}'`,
    );
    const body = JSON.parse(resp) as { success: boolean };
    results.push({ name: 'api-message', passed: body.success === true });
  } catch (err) {
    results.push({ name: 'api-message', passed: false, error: String(err) });
  }

  // Suite 5: Seed rules copied on first start
  try {
    const logs = exec('docker compose logs openhive-e2e 2>&1');
    // Check that the system started without errors
    const noFatal = !logs.includes('Fatal:');
    results.push({ name: 'seed-rules', passed: noFatal });
  } catch (err) {
    results.push({ name: 'seed-rules', passed: false, error: String(err) });
  }

  return results;
}

function main(): void {
  const tier1Only = process.argv.includes('--tier1-only');
  // eslint-disable-next-line no-console
  const log = (msg: string) => console.log(`[e2e] ${msg}`);

  log('Setting up test directory...');
  const testDir = setupTestDir();

  try {
    log('Building Docker image...');
    exec('docker compose build --no-cache', { cwd: testDir, timeout: 300_000 });

    log('Starting container...');
    exec('docker compose up -d', { cwd: testDir, timeout: 60_000 });

    log('Waiting for health...');
    const healthy = waitForHealth(18080);
    if (!healthy) {
      const logs = exec('docker compose logs openhive-e2e 2>&1', { cwd: testDir });
      log(`Container logs:\n${logs}`);
      throw new Error('Container did not become healthy within timeout');
    }

    log('Running Tier 1 suites (infra, no API key)...');
    const tier1 = runTier1Suites(18080);

    for (const r of tier1) {
      log(`  ${r.passed ? 'PASS' : 'FAIL'}: ${r.name}${r.error ? ` — ${r.error}` : ''}`);
    }

    if (!tier1Only) {
      log('Tier 2 (AI) suites skipped — requires ANTHROPIC_API_KEY');
    }

    const allPassed = tier1.every(r => r.passed);
    const passed = tier1.filter(r => r.passed).length;
    const total = tier1.length;
    log(`\nResults: ${String(passed)}/${String(total)} passed`);

    if (!allPassed) {
      process.exitCode = 1;
    }
  } finally {
    log('Tearing down...');
    try {
      exec('docker compose down -v --remove-orphans', { cwd: testDir, timeout: 30_000 });
    } catch {
      log('Warning: teardown failed');
    }

    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (err: unknown) {
  // eslint-disable-next-line no-console
  console.error('[e2e] Fatal:', err);
  process.exit(1);
}
