'use strict';
const h = require('../run-helpers.cjs');

/** Suite C: Stress & Recovery */
module.exports = async function suiteC() {
  const r = h.newSuiteResult();

  // 1: Setup
  await h.runStep(r, 'create-stress-team', () =>
    h.wsSend('main', 'Create a team called stress-team for testing. Accept keywords: testing'));
  await h.runStep(r, 'insert-baseline-memory', () => {
    h.dbExec(db => db.prepare(
      "INSERT INTO memories (team_name, key, content, type, is_active, created_at, updated_at) VALUES ('main', 'stress-baseline', 'Stress test baseline', 'context', 1, datetime('now'), datetime('now'))"
    ).run());
    return { ok: true };
  });

  // 2: Open 5 connections
  for (let i = 1; i <= 5; i++) await h.wsConnect(`s${i}`);

  // 3: 5 concurrent messages
  await h.runStep(r, 'concurrent-sends', async () => {
    const msgs = [
      { name: 's1', content: 'What is 2+2?' },
      { name: 's2', content: 'What is the capital of France?' },
      { name: 's3', content: 'List 3 colors' },
      { name: 's4', content: 'What teams do you have?' },
      { name: 's5', content: 'Who are you?' },
    ];
    const results = await Promise.all(msgs.map(m => h.wsSend(m.name, m.content, 300000)));
    return { allOk: results.every(x => x.ok), results: results.map((x, i) => ({ name: msgs[i].name, ok: x.ok, final: (x.final || '').slice(0, 100) })) };
  });

  // 4: Verify
  await h.runStep(r, 'verify-after-concurrent', () => h.runVerify('verify-suite-stress.cjs', 'after-concurrent'));
  for (let i = 1; i <= 5; i++) await h.wsDisconnect(`s${i}`);

  // 5: Per-socket serialization
  const ser = await h.runStep(r, 'serialization-test', async () => {
    const traffic = await h.wsTraffic({ name: 'main', limit: 1 });
    const lastSeq = (traffic.entries && traffic.entries.length > 0) ? traffic.entries[traffic.entries.length - 1].seq : 0;
    await h.wsSendFire('main', 'Tell me a long story about dragons');
    await h.sleep(100);
    await h.wsSendFire('main', 'What is 1+1?');
    return h.wsExchange('main', lastSeq, 300000, 2);
  });
  if (ser) {
    const frames = ser.frames || [];
    const hasErr = frames.some(f => f.type === 'error' && (f.content || '').toLowerCase().includes('request in progress'));
    const hasResp = frames.some(f => f.type === 'response');
    h.flagSemanticCheck('C', 'serialization',
      `Do frames contain "request in progress" error (${hasErr}) AND a response (${hasResp})?`,
      JSON.stringify(frames.map(f => ({ type: f.type, content: (f.content || '').slice(0, 100) }))));
  }

  // 6: Restart + recovery
  await h.dockerRestart();
  await h.wsReconnect('main');
  await h.runStep(r, 'verify-after-restart', () => h.runVerify('verify-suite-stress.cjs', 'after-restart'));
  const sanity = await h.runStep(r, 'post-restart-sanity', () => h.wsSend('main', 'Hello, are you working?'));
  if (sanity) h.flagSemanticCheck('C', 'post-restart', 'Does the response contain a coherent answer?', sanity.final);

  return r;
};
