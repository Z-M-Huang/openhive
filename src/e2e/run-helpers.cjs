/**
 * Shared helpers for the E2E test runner.
 *
 * Exports: constants, low-level helpers, harness helpers, infrastructure
 * helpers, verify runner, and report builder.
 *
 * Security note on shell(): Used ONLY for hardcoded docker-compose
 * commands that need shell features (pipes, || true, redirects, globs).
 * No external/user input is ever interpolated. All other commands use
 * execFileSync (no shell injection risk).
 */

'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFileSync, execSync, spawn } = require('child_process');

// ── Constants ────────────────────────────────────────────────────────────────

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const E2E_DIR = __dirname;
const RUN_DIR = path.resolve(PROJECT_ROOT, '.run');
const DB_PATH = path.resolve(RUN_DIR, 'openhive.db');
const REPORT_PATH = path.resolve(RUN_DIR, 'e2e-report.json');
const HARNESS_SCRIPT = path.resolve(PROJECT_ROOT, 'ws-harness.cjs');
const COMPOSE_FILE = path.resolve(PROJECT_ROOT, 'deployments/docker-compose.yml');
const CONTAINER = process.env.CONTAINER_NAME || 'openhive';
const HARNESS_PORT = parseInt(process.env.HARNESS_PORT || '9876', 10);
const HARNESS_HOST = '127.0.0.1';

// ── Low-Level Helpers ────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function harnessPost(endpoint, body, timeoutMs = 310000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: HARNESS_HOST, port: HARNESS_PORT, path: endpoint, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ ok: false, error: 'invalid JSON response', raw }); }
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error(`harness timeout: ${endpoint}`)); });
    req.write(data);
    req.end();
  });
}

function harnessGet(endpoint, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: HARNESS_HOST, port: HARNESS_PORT, path: endpoint, method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        try { resolve(JSON.parse(raw)); }
        catch { resolve({ ok: false, error: 'invalid JSON', raw }); }
      });
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error(`GET timeout: ${endpoint}`)); });
    req.end();
  });
}

function httpGet(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', e => reject(e));
    req.on('timeout', () => { req.destroy(); reject(new Error(`httpGet timeout: ${url}`)); });
  });
}

/** execFileSync wrapper (no shell). Does NOT throw on nonzero exit. */
function run(cmd, cmdArgs, opts = {}) {
  try {
    const stdout = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8', timeout: opts.timeout || 120000,
      cwd: opts.cwd || PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: (e.stdout || '').toString().trim(),
      stderr: (e.stderr || '').toString().trim(),
      exitCode: e.status ?? 1,
    };
  }
}

/**
 * execSync wrapper for hardcoded shell commands only (docker-compose
 * pipelines, glob copies). Never receives external input.
 */
function shell(cmd, opts = {}) {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf8', timeout: opts.timeout || 120000,
      cwd: opts.cwd || PROJECT_ROOT, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout.trim(), stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout: (e.stdout || '').toString().trim(),
      stderr: (e.stderr || '').toString().trim(),
      exitCode: e.status ?? 1,
    };
  }
}

let _Database = null;
function getDatabase() {
  if (!_Database) _Database = require(path.resolve(PROJECT_ROOT, 'node_modules/better-sqlite3'));
  return _Database;
}

function dbQuery(fn) {
  const Database = getDatabase();
  const db = Database(DB_PATH, { readonly: true });
  try { return fn(db); } finally { db.close(); }
}

function dbExec(fn) {
  const Database = getDatabase();
  const db = Database(DB_PATH);
  try { return fn(db); } finally { db.close(); }
}

async function poll(description, checkFn, { maxMs = 60000, intervalMs = 3000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const result = checkFn();
      if (result && result.done) return result.value;
    } catch { /* ignore, retry */ }
    await sleep(intervalMs);
  }
  throw new Error(`Polling timeout (${maxMs}ms): ${description}`);
}

// ── Harness Helpers ──────────────────────────────────────────────────────────

async function wsConnect(name, url) {
  const body = { name };
  if (url) body.url = url;
  return harnessPost('/connect', body, 15000);
}
async function wsReconnect(name) { return harnessPost('/reconnect', { name }, 15000); }
async function wsDisconnect(name) { return harnessPost('/disconnect', { name }, 10000); }
async function wsReset() { return harnessPost('/reset', {}, 10000); }
async function wsSend(name, content, timeout = 300000) { return harnessPost('/send', { name, content, timeout }, timeout + 10000); }
async function wsSendFire(name, content) { return harnessPost('/send_fire', { name, content }, 10000); }
async function wsExchange(name, sinceSeq, timeout = 300000, terminalCount = 1) { return harnessPost('/exchange', { name, since_seq: sinceSeq, timeout, terminal_count: terminalCount }, timeout + 10000); }
async function wsNotifications(name, sinceSeq = 0) { return harnessPost('/notifications', { name, since_seq: sinceSeq }, 10000); }
async function wsTraffic(opts) { return harnessPost('/traffic', opts, 10000); }
async function wsSendRaw(name, payload, timeout = 10000) { return harnessPost('/send_raw', { name, payload, timeout }, timeout + 5000); }
async function wsStatus() { return harnessGet('/status', 5000); }

// ── Infrastructure Helpers ───────────────────────────────────────────────────

async function waitHealth(maxMs = 90000, intervalMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const { status } = await httpGet('http://localhost:8080/health', 5000);
      if (status === 200) return true;
    } catch { /* retry */ }
    await sleep(intervalMs);
  }
  throw new Error(`Health check timeout after ${maxMs}ms`);
}

function waitBootstrap(teamName, maxMs = 60000, intervalMs = 3000) {
  return poll(`${teamName} bootstrap`, () => {
    const row = dbQuery(db => db.prepare("SELECT bootstrapped FROM org_tree WHERE name=?").get(teamName));
    if (row && row.bootstrapped === 1) return { done: true, value: true };
    return { done: false };
  }, { maxMs, intervalMs });
}

function waitTaskComplete(teamId, taskLike, maxMs = 60000, intervalMs = 5000) {
  return poll(`${teamId} task complete`, () => {
    const row = dbQuery(db => {
      if (taskLike) return db.prepare("SELECT status, result FROM task_queue WHERE team_id=? AND task LIKE ? ORDER BY created_at DESC LIMIT 1").get(teamId, taskLike);
      return db.prepare("SELECT status, result FROM task_queue WHERE team_id=? ORDER BY created_at DESC LIMIT 1").get(teamId);
    });
    if (row && (row.status === 'completed' || row.status === 'failed')) return { done: true, value: row };
    return { done: false };
  }, { maxMs, intervalMs });
}

function waitTaskCount(teamId, taskLike, minCount, maxMs = 150000, intervalMs = 5000) {
  return poll(`${teamId} task count >= ${minCount}`, () => {
    const row = dbQuery(db => db.prepare("SELECT COUNT(*) AS c FROM task_queue WHERE team_id=? AND task LIKE ?").get(teamId, taskLike));
    if (row && row.c >= minCount) return { done: true, value: row.c };
    return { done: false };
  }, { maxMs, intervalMs });
}

async function cleanRestart() {
  log('Clean restart: down + wipe + up...');
  shell('sudo docker compose -f "' + COMPOSE_FILE + '" down -v 2>&1 || true', { timeout: 60000 });
  run('sudo', ['rm', '-rf', RUN_DIR]);
  run('mkdir', ['-p', RUN_DIR]);
  shell('rm -f "' + PROJECT_ROOT + '/data/rules/"*.md');
  shell('cp "' + PROJECT_ROOT + '/seed-rules/"* "' + PROJECT_ROOT + '/data/rules/" 2>/dev/null || true');
  // Ensure WS is enabled for e2e test harness
  const channelsYaml = PROJECT_ROOT + '/data/config/channels.yaml';
  if (fs.existsSync(channelsYaml)) {
    let content = fs.readFileSync(channelsYaml, 'utf8');
    if (!content.includes('ws:')) {
      content += '\nws:\n  enabled: true\n';
      fs.writeFileSync(channelsYaml, content);
      log('Injected ws: { enabled: true } into channels.yaml');
    }
  }
  shell('sudo docker compose -f "' + COMPOSE_FILE + '" up -d 2>&1', { timeout: 60000 });
  await waitHealth(90000, 3000);
  log('Clean restart complete, server healthy');
}

async function dockerRestart() {
  log('Docker restart (data-preserving)...');
  run('sudo', ['docker', 'restart', CONTAINER], { timeout: 60000 });
  await waitHealth(90000, 3000);
  log('Docker restart complete, server healthy');
}

async function dockerBuild() {
  log('Building Docker image (no-cache)...');
  shell('sudo docker compose -f "' + COMPOSE_FILE + '" build --no-cache 2>&1 | tail -5', { timeout: 600000 });
  log('Docker build complete');
}

let harnessProc = null;
async function startHarness() {
  log('Starting WS harness...');
  harnessProc = spawn('node', [HARNESS_SCRIPT], {
    cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: false,
  });
  harnessProc.stdout.on('data', () => {});
  harnessProc.stderr.on('data', () => {});
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try { const s = await wsStatus(); if (s.ok) { log('WS harness ready'); return; } } catch { /* retry */ }
    await sleep(500);
  }
  throw new Error('Harness failed to start within 10s');
}

async function stopHarness() {
  if (harnessProc) {
    try { await harnessPost('/shutdown', {}, 5000); } catch { /* ignore */ }
    harnessProc.kill();
    harnessProc = null;
  }
}

// ── Verify Runner ────────────────────────────────────────────────────────────

function runVerify(script, step) {
  const scriptPath = path.resolve(E2E_DIR, script);
  const result = run('node', [scriptPath, '--step', step], { timeout: 30000 });
  if (result.exitCode === 0 || result.stdout) {
    try { return JSON.parse(result.stdout); }
    catch { return { suite: script, step, checks: [], summary: { total: 0, passed: 0, failed: 0 }, error: `Invalid JSON: ${result.stdout.slice(0, 200)}` }; }
  }
  return { suite: script, step, checks: [], summary: { total: 0, passed: 0, failed: 0 }, error: result.stderr || `exit code ${result.exitCode}` };
}

// ── Report Builder ───────────────────────────────────────────────────────────

const report = {
  startedAt: null, finishedAt: null, durationMs: null, exitCode: 0,
  options: {},
  suites: {},
  semanticChecks: [],
  summary: { totalSuites: 0, passedSuites: 0, failedSuites: 0, skippedSuites: 0, totalChecks: 0, passedChecks: 0, failedChecks: 0 },
};

async function runStep(suiteResult, stepName, fn) {
  const start = Date.now();
  const stepRecord = { name: stepName, durationMs: 0, result: null, error: null };
  try {
    const result = await fn();
    stepRecord.result = result;
    if (result && result.summary && typeof result.summary.failed === 'number') {
      suiteResult.verifications.push(result);
      if (result.summary.failed > 0) suiteResult.hasFails = true;
    }
    if (result && typeof result.final === 'string') {
      suiteResult.wsResponses.push({ step: stepName, final: result.final, elapsed: result.elapsed });
    }
    return result;
  } catch (err) {
    stepRecord.error = err.message;
    suiteResult.errors.push({ step: stepName, error: err.message });
    return null;
  } finally {
    stepRecord.durationMs = Date.now() - start;
    suiteResult.steps.push(stepRecord);
  }
}

function flagSemanticCheck(suite, step, question, evidence) {
  report.semanticChecks.push({ suite, step, question, evidence: (evidence || '').slice(0, 2000) });
}

function recordSuite(name, result) {
  result.status = result.status || (result.hasFails || result.errors.length > 0 ? 'failed' : 'passed');
  report.suites[name] = result;
  report.summary.totalSuites++;
  if (result.status === 'passed') report.summary.passedSuites++;
  else if (result.status === 'skipped') report.summary.skippedSuites++;
  else report.summary.failedSuites++;
  for (const v of result.verifications || []) {
    report.summary.totalChecks += v.summary.total;
    report.summary.passedChecks += v.summary.passed;
    report.summary.failedChecks += v.summary.failed;
  }
}

function newSuiteResult() {
  return { status: null, hasFails: false, startedAt: new Date().toISOString(), steps: [], verifications: [], wsResponses: [], errors: [] };
}

function finalizeReport() {
  report.finishedAt = new Date().toISOString();
  report.durationMs = new Date(report.finishedAt) - new Date(report.startedAt);
  try {
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    log(`Report written to ${REPORT_PATH}`);
  } catch (e) {
    log(`Failed to write report: ${e.message}`);
    console.log(JSON.stringify(report, null, 2));
  }
}

module.exports = {
  PROJECT_ROOT, E2E_DIR, RUN_DIR, DB_PATH, REPORT_PATH, CONTAINER, COMPOSE_FILE,
  sleep, log, run, shell, dbQuery, dbExec, poll, httpGet,
  wsConnect, wsReconnect, wsDisconnect, wsReset, wsSend, wsSendFire,
  wsExchange, wsNotifications, wsTraffic, wsSendRaw, wsStatus,
  waitHealth, waitBootstrap, waitTaskComplete, waitTaskCount,
  cleanRestart, dockerRestart, dockerBuild, startHarness, stopHarness,
  runVerify,
  report, runStep, flagSemanticCheck, recordSuite, newSuiteResult, finalizeReport,
};
