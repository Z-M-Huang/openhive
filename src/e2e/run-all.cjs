#!/usr/bin/env node
/**
 * OpenHive E2E Test Runner — Orchestrator
 *
 * Runs all e2e suites mechanically and generates a JSON report.
 * AI reviews the report afterward instead of driving each step.
 *
 * Usage:
 *   node src/e2e/run-all.cjs                  # full run (build + all suites)
 *   node src/e2e/run-all.cjs --skip-build     # skip docker build
 *   node src/e2e/run-all.cjs --suite PLATFORM  # run only PLATFORM suite (+ smoke)
 *   node src/e2e/run-all.cjs --suite smoke    # run only smoke checks
 */

'use strict';

const h = require('./run-helpers.cjs');

// ── CLI Parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const options = { suite: null, skipBuild: false, help: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--suite' && args[i + 1]) { options.suite = args[++i].toUpperCase(); }
  else if (args[i] === '--skip-build') { options.skipBuild = true; }
  else if (args[i] === '--help') { options.help = true; }
}

if (options.help) {
  console.log('Usage: node src/e2e/run-all.cjs [--skip-build] [--suite <SMOKE|PLATFORM|BROWSER>]');
  process.exit(0);
}

// ── Suite Registry ───────────────────────────────────────────────────────────

const SUITES = {
  PLATFORM: require('./suites/suite-platform.cjs'),
  BROWSER: require('./suites/suite-d.cjs'),
};
const suiteSmoke = require('./suites/smoke.cjs');

// ── Main ─────────────────────────────────────────────────────────────────────

function hasInfraFailures(smokeResult) {
  for (const v of smokeResult.verifications) {
    if ((v.step === 'infrastructure' || v.step === 'database') && v.summary.failed > 0) return true;
  }
  return false;
}

async function main() {
  h.report.startedAt = new Date().toISOString();
  h.report.options = { ...options };
  const ctx = { skipBrowserSuite: false };

  try {
    // Phase 0: Build
    if (!options.skipBuild) await h.dockerBuild();

    // Phase 1: Initial start + harness
    await h.cleanRestart();
    await h.startHarness();
    await h.wsReset();
    await h.wsConnect('main');

    // Phase 2: Smoke checks (always run)
    h.log('\n========================================');
    h.log('  SMOKE CHECKS');
    h.log('========================================');
    const smokeResult = await suiteSmoke();
    smokeResult.durationMs = new Date() - new Date(smokeResult.startedAt);
    h.recordSuite('smoke', smokeResult);

    if (smokeResult.status === 'failed' && hasInfraFailures(smokeResult)) {
      h.log('STOP GATE: Infrastructure/database smoke checks failed. Aborting.');
      h.report.exitCode = 2;
      h.finalizeReport();
      process.exit(2);
    }

    ctx.skipBrowserSuite = !smokeResult.browserAvailable;
    if (options.suite === 'SMOKE') {
      h.finalizeReport();
      process.exit(h.report.exitCode);
    }

    // Phase 3: Suites (PLATFORM + BROWSER)
    const suitesToRun = options.suite ? [options.suite] : ['PLATFORM', 'BROWSER'];

    for (const id of suitesToRun) {
      h.log(`\n========================================`);
      h.log(`  SUITE ${id}`);
      h.log('========================================');

      if (id === 'BROWSER' && ctx.skipBrowserSuite) {
        const skip = h.newSuiteResult();
        skip.status = 'skipped';
        h.recordSuite('BROWSER', skip);
        h.log('Suite BROWSER skipped (browser not available)');
        continue;
      }

      await h.cleanRestart();
      await h.wsReset();
      await h.wsConnect('main');

      const fn = SUITES[id];
      if (!fn) { h.log(`Unknown suite: ${id}`); continue; }

      const start = Date.now();
      const result = await fn(ctx);
      result.durationMs = Date.now() - start;
      h.recordSuite(id, result);

      if (result.status === 'failed') h.report.exitCode = Math.max(h.report.exitCode, 1);
      h.log(`Suite ${id}: ${result.status} (${Math.round(result.durationMs / 1000)}s)`);
    }

  } catch (err) {
    h.log(`FATAL: ${err.message}`);
    h.report.exitCode = 2;
    h.report.suites._fatal = { status: 'failed', error: err.message, stack: err.stack };
  } finally {
    await h.stopHarness().catch(() => {});
    h.finalizeReport();

    h.log('\n========================================');
    h.log('  SUMMARY');
    h.log('========================================');
    h.log(`Suites: ${h.report.summary.passedSuites} passed, ${h.report.summary.failedSuites} failed, ${h.report.summary.skippedSuites} skipped`);
    h.log(`Checks: ${h.report.summary.passedChecks}/${h.report.summary.totalChecks} passed`);
    h.log(`Semantic reviews: ${h.report.semanticChecks.length} items for AI review`);
    h.log(`Duration: ${Math.round(h.report.durationMs / 1000)}s`);
    h.log(`Exit code: ${h.report.exitCode}`);
  }

  process.exit(h.report.exitCode);
}

main();
