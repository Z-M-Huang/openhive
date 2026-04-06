'use strict';
const h = require('../run-helpers.cjs');

/** Suite H: Trust */
module.exports = async function suiteH() {
  const r = h.newSuiteResult();

  // Part 1: Schema
  await h.runStep(r, 'verify-after-schema-check', () => h.runVerify('verify-suite-trust.cjs', 'after-schema-check'));

  // Part 2: Trust scoring
  const trust = await h.runStep(r, 'trust-test-message', () => h.wsSend('main', 'Hello, this is a trust test message.'));
  if (trust) h.flagSemanticCheck('H', 'trust-allow', 'Response is a normal answer (not blocked)?', trust.final);
  await h.runStep(r, 'verify-after-trust-score', () => h.runVerify('verify-suite-trust.cjs', 'after-trust-score'));

  // Part 3: Enforcement
  const enforce = await h.runStep(r, 'trust-enforce-message', () => h.wsSend('main', 'What teams exist?'));
  if (enforce) h.flagSemanticCheck('H', 'trust-enforce', 'Does the response list teams (not blocked)?', enforce.final);
  await h.runStep(r, 'verify-after-trust-enforce', () => h.runVerify('verify-suite-trust.cjs', 'after-trust-enforce'));

  // Part 4: Cleanup
  await h.runStep(r, 'health-check', async () => {
    const { status } = await h.httpGet('http://localhost:8080/health', 5000);
    if (status !== 200) throw new Error(`Health ${status}`);
    return { ok: true };
  });
  await h.runStep(r, 'verify-after-cleanup', () => h.runVerify('verify-suite-trust.cjs', 'after-cleanup'));

  return r;
};
