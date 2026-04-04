/**
 * Shared helpers for e2e verification scripts.
 *
 * Usage:
 *   const { openDb, check, runStep, fileExists, fileContains, dirHasFiles } = require('./verify-helpers.cjs');
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH = path.resolve(__dirname, '../../.run/openhive.db');
const RUN_DIR = path.resolve(__dirname, '../../.run');

/** Open the SQLite database readonly. Returns the Database instance. */
function openDb() {
  const Database = require(path.resolve(__dirname, '../../node_modules/better-sqlite3'));
  return Database(DB_PATH, { readonly: true });
}

/**
 * Create a check result object.
 * @param {string} name   - Check identifier
 * @param {boolean} pass  - Whether the check passed
 * @param {string} expected
 * @param {string} actual
 */
function check(name, pass, expected, actual) {
  return { name, pass, expected: String(expected), actual: String(actual) };
}

/** Check if a file exists. */
function fileExists(filePath) {
  return fs.existsSync(filePath);
}

/** Check if a file contains a substring. Returns the match or null. */
function fileContains(filePath, substring) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, 'utf8');
  return content.includes(substring) ? substring : null;
}

/** Check if a directory has files (optionally matching an extension). */
function dirHasFiles(dirPath, ext) {
  if (!fs.existsSync(dirPath)) return [];
  const files = fs.readdirSync(dirPath);
  if (ext) return files.filter(f => f.endsWith(ext));
  return files;
}

/** Read a team's config.yaml and return raw content. */
function readConfig(teamName) {
  const configPath = path.join(RUN_DIR, 'teams', teamName, 'config.yaml');
  if (!fs.existsSync(configPath)) return null;
  return fs.readFileSync(configPath, 'utf8');
}

/** Get docker logs as array of lines. Uses execFileSync to avoid shell injection. */
function dockerLogs(containerName) {
  const name = containerName || 'openhive';
  try {
    const out = execFileSync('sudo', ['docker', 'logs', name], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // docker logs writes to both stdout and stderr; combine
    return out.trim().split('\n').filter(Boolean);
  } catch (e) {
    // stderr contains the logs for docker
    const stderr = e.stderr ? e.stderr.toString() : '';
    const stdout = e.stdout ? e.stdout.toString() : '';
    const combined = stdout + '\n' + stderr;
    return combined.trim().split('\n').filter(Boolean);
  }
}

/** Check docker logs do NOT contain a literal string (credential leak check). */
function dockerLogsAbsent(literal, containerName) {
  const lines = dockerLogs(containerName);
  return !lines.some(line => line.includes(literal));
}

/** Check docker logs contain a pattern (case-insensitive). */
function dockerLogsContain(pattern, containerName) {
  const lines = dockerLogs(containerName);
  const re = new RegExp(pattern, 'i');
  return lines.filter(line => re.test(line));
}

/**
 * Run a step's checks and output structured JSON.
 * @param {string} suite  - Suite name
 * @param {Object} steps  - Map of step name → function returning check array
 */
function runStep(suite, steps) {
  const args = process.argv.slice(2);
  const stepIdx = args.indexOf('--step');
  const stepName = stepIdx >= 0 ? args[stepIdx + 1] : null;

  if (!stepName || !steps[stepName]) {
    const available = Object.keys(steps).join(', ');
    console.error(`Usage: node ${path.basename(process.argv[1])} --step <${available}>`);
    process.exit(1);
  }

  let db;
  try {
    db = openDb();
  } catch {
    // DB might not exist yet for some steps
    db = null;
  }

  try {
    const checks = steps[stepName](db);
    const passed = checks.filter(c => c.pass).length;
    const failed = checks.filter(c => !c.pass).length;

    const result = {
      suite,
      step: stepName,
      checks,
      summary: { total: checks.length, passed, failed },
    };

    console.log(JSON.stringify(result, null, 2));
    process.exit(failed > 0 ? 1 : 0);
  } finally {
    if (db) db.close();
  }
}

module.exports = {
  openDb,
  check,
  fileExists,
  fileContains,
  dirHasFiles,
  readConfig,
  dockerLogs,
  dockerLogsAbsent,
  dockerLogsContain,
  runStep,
  DB_PATH,
  RUN_DIR,
};
