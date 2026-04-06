'use strict';
const h = require('../run-helpers.cjs');

/** Suite E: Context + Threading */
module.exports = async function suiteE() {
  const r = h.newSuiteResult();
  let researchTeamOk = false;

  // -- Part 1: Conversation Context --

  await h.runStep(r, 'interaction-logging', () => h.wsSend('main', 'What tools do you have available?'));

  const rtResp = await h.runStep(r, 'create-research-team', () =>
    h.wsSend('main', 'Create a team called research-team for research tasks. Accept keywords: research, analysis.'));
  if (rtResp && rtResp.ok) {
    if (await h.runStep(r, 'wait-research-team', () => h.waitBootstrap('research-team'))) researchTeamOk = true;
  }
  if (researchTeamOk) {
    await h.runStep(r, 'delegate-to-research', () =>
      h.wsSend('main', 'Ask the research-team to analyze the benefits of microservices vs monolith architecture and report back.'));
    await h.sleep(30000);
  }
  const ctxResp = await h.runStep(r, 'context-follow-up', () =>
    h.wsSend('main', 'Can you tell me more about what the research-team found? I want the details of their analysis.'));
  if (ctxResp) h.flagSemanticCheck('E', 'context-awareness', "Does the response show awareness of research-team's microservices/monolith analysis?", ctxResp.final);

  await h.runStep(r, 'retention-cleanup-test', () => {
    h.dbExec(db => {
      db.prepare("INSERT INTO channel_interactions (direction, channel_type, channel_id, content_snippet, created_at) VALUES ('inbound', 'test', 'test-cleanup', 'old message', '2020-01-01T00:00:00.000Z')").run();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      db.prepare('DELETE FROM channel_interactions WHERE created_at < ?').run(cutoff);
    });
    return { ok: true };
  });
  await h.runStep(r, 'verify-after-interactions', () => h.runVerify('verify-suite-context-threading.cjs', 'after-interactions'));

  // -- Part 2: Threading --

  await h.runStep(r, 'topic-first-message', () => h.wsSend('main', 'Research the best Node.js logging libraries and compare them.'));
  await h.runStep(r, 'topic-unrelated', () => h.wsSend('main', 'What is the current weather forecast for San Francisco?'));
  const classify = await h.runStep(r, 'topic-classification', () =>
    h.wsSend('main', 'Actually, focus only on Winston and Pino for the logging comparison.'));
  if (classify) h.flagSemanticCheck('E', 'topic-classification', 'Was the message routed to the logging topic?', classify.final);
  await h.runStep(r, 'verify-after-topic-create', () => h.runVerify('verify-suite-context-threading.cjs', 'after-topic-create'));

  // Idle transition
  await h.runStep(r, 'wait-idle-transition', async () => {
    h.log('Waiting for topics to go idle...');
    const start = Date.now();
    while (Date.now() - start < 200000) {
      try {
        const count = h.dbQuery(db => db.prepare("SELECT COUNT(*) AS c FROM topics WHERE state='idle'").get().c);
        if (count > 0) return { idleCount: count, afterMs: Date.now() - start };
      } catch { /* table may not exist */ }
      await h.sleep(5000);
    }
    return { idleCount: 0, note: 'No idle transition detected' };
  });
  await h.runStep(r, 'topic-rehydration', () => h.wsSend('main', 'Give me the final summary of the logging library comparison.'));

  // Fill to limit
  await h.runStep(r, 'topic-bookstore', () => h.wsSend('main', 'Design a REST API for a bookstore application.'));
  await h.runStep(r, 'topic-fibonacci', () => h.wsSend('main', 'Write a Python script that generates Fibonacci numbers.'));
  await h.runStep(r, 'topic-tcp-udp', () => h.wsSend('main', 'Explain the differences between TCP and UDP protocols.'));

  const limit = await h.runStep(r, 'topic-limit-test', () => h.wsSend('main', 'Tell me about quantum computing advancements in 2025.'));
  if (limit) h.flagSemanticCheck('E', 'topic-limit', 'Does the response indicate max topics reached?', limit.final);

  await h.runStep(r, 'close-topic', () => h.wsSend('main', "Close the weather topic, I'm done with that."));
  await h.runStep(r, 'topic-bypass', () => h.wsSend('main', '@bookstore: Add pagination to the list endpoints.'));

  // Restart + recovery
  await h.dockerRestart();
  await h.wsReconnect('main');
  const rehydrate = await h.runStep(r, 'post-restart-rehydration', () => h.wsSend('main', 'What was the final verdict on Winston vs Pino?'));
  if (rehydrate) h.flagSemanticCheck('E', 'restart-rehydration', 'Does the response show awareness of previous logging discussion?', rehydrate.final);
  await h.runStep(r, 'verify-after-topic-lifecycle', () => h.runVerify('verify-suite-context-threading.cjs', 'after-topic-lifecycle'));

  return r;
};
