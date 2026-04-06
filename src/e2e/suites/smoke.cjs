'use strict';
const h = require('../run-helpers.cjs');

module.exports = async function suiteSmoke() {
  const r = h.newSuiteResult();
  let browserAvailable = false;

  await h.runStep(r, 'verify-infrastructure', () => h.runVerify('verify-smoke.cjs', 'infrastructure'));
  await h.runStep(r, 'verify-database', () => h.runVerify('verify-smoke.cjs', 'database'));
  await h.runStep(r, 'verify-enhanced', () => h.runVerify('verify-smoke.cjs', 'enhanced'));

  // WS protocol (14-17)
  await h.runStep(r, 'ws-ping', async () => {
    const resp = await h.wsSend('main', 'ping', 30000);
    if (!resp.ok) throw new Error(`WS ping failed: ${resp.error || 'no response'}`);
    return resp;
  });
  await h.runStep(r, 'ws-raw-invalid', () => h.wsSendRaw('main', 'not json', 10000));
  await h.runStep(r, 'ws-raw-empty-content', () => h.wsSendRaw('main', '{"content":""}', 10000));
  await h.runStep(r, 'health-after-errors', async () => {
    const { status } = await h.httpGet('http://localhost:8080/health', 5000);
    if (status !== 200) throw new Error(`Health returned ${status}`);
    return { ok: true };
  });

  // Progressive protocol (18-19)
  await h.runStep(r, 'ws-progressive', async () => {
    const resp = await h.wsSend('main', 'Hello', 60000);
    if (!resp.ok) throw new Error('Progressive WS failed');
    if (!resp.exchange || !resp.exchange.length || !resp.exchange[0].type) throw new Error('Missing type field');
    if (resp.exchange[resp.exchange.length - 1].type !== 'response') throw new Error('Last frame not response');
    return resp;
  });

  // System rules (20)
  await h.runStep(r, 'system-rules', () => {
    const result = h.run('sudo', ['docker', 'exec', h.CONTAINER, 'grep', '-c', 'denied by default', '/app/system-rules/sdk-capabilities.md']);
    const count = parseInt(result.stdout, 10) || 0;
    if (count > 0) throw new Error(`sdk-capabilities.md contains "denied by default" (${count})`);
    return { ok: true, count };
  });

  // Browser (21-22)
  await h.runStep(r, 'browser-preflight', () => {
    const result = h.run('sudo', ['docker', 'exec', h.CONTAINER, 'node', '-e', "require('@playwright/mcp'); console.log('OK')"]);
    browserAvailable = result.exitCode === 0 && result.stdout.includes('OK');
    if (!browserAvailable) h.log('Browser relay NOT available — Suite D will be skipped');
    return { browserAvailable };
  });

  // Frame ordering (23)
  await h.runStep(r, 'frame-ordering', async () => {
    const traffic = await h.wsTraffic({ name: 'main', direction: 'recv', limit: 20 });
    if (!traffic.ok) throw new Error('Traffic query failed');
    const entries = traffic.entries || [];
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].seq <= entries[i - 1].seq) throw new Error(`Out-of-order: seq ${entries[i - 1].seq} >= ${entries[i].seq}`);
    }
    return { ok: true, frameCount: entries.length };
  });

  // Skills (24)
  const skillsResp = await h.runStep(r, 'skills-check', () => h.wsSend('main', 'What skills did you load?', 60000));
  if (skillsResp) h.flagSemanticCheck('smoke', 'skills-check', 'Does the response mention available skills?', skillsResp.final);

  r.browserAvailable = browserAvailable;
  return r;
};
