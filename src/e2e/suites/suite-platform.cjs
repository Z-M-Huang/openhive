'use strict';
const h = require('../run-helpers.cjs');

/**
 * PLATFORM mega-suite — combines suites A, B, C, E, F, G, H, I
 * into 10 phases with 3 docker restarts.
 *
 * Phase 1:  Foundation          [H + I]   — baseline verification, no teams
 * Phase 2:  Teams + Vault       [A]       — team hierarchy, vault CRUD, delegation
 * Phase 3:  Triggers            [B pt1]   — create triggers, cron
 *     ─── dockerRestart #1 ───
 * Phase 4:  Persistence         [A restart + B restart + B pt2]
 * Phase 5:  Skills              [G]       — skill search/create, shutdown
 * Phase 6:  Stress              [C]       — concurrent connections
 *     ─── dockerRestart #2 ───
 * Phase 7:  Recovery            [C restart]
 * Phase 8:  Context/Threading   [E]       — topics, idle, rehydration
 *     ─── dockerRestart #3 ───
 * Phase 9:  Topic Persistence   [E restart]
 * Phase 10: Cascade Deletion    [F]       — destructive, always last
 */
module.exports = async function suitePlatform() {
  const r = h.newSuiteResult();

  // Track cross-phase state
  let opsTeamOk = false, alphaOk = false;
  let logglyOk = false, healthCheckerOk = false;
  let taskCountBefore = 0;
  let baselineNotifCount = 0;
  let skillTeamOk = false;
  let researchTeamOk = false;
  let a1Ok = false;

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 1: Foundation [H + I] — baseline verification, no teams
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 1: Foundation [H + I] ────');

  // H: Schema
  await h.runStep(r, 'H:verify-after-schema-check', () => h.runVerify('verify-suite-trust.cjs', 'after-schema-check'));

  // H: Trust scoring
  const trust = await h.runStep(r, 'H:trust-test-message', () => h.wsSend('main', 'Hello, this is a trust test message.'));
  if (trust) h.flagSemanticCheck('H', 'trust-allow', 'Response is a normal answer (not blocked)?', trust.final);
  await h.runStep(r, 'H:verify-after-trust-score', () => h.runVerify('verify-suite-trust.cjs', 'after-trust-score'));

  // H: Enforcement
  const enforce = await h.runStep(r, 'H:trust-enforce-message', () => h.wsSend('main', 'What teams exist?'));
  if (enforce) h.flagSemanticCheck('H', 'trust-enforce', 'Does the response list teams (not blocked)?', enforce.final);
  await h.runStep(r, 'H:verify-after-trust-enforce', () => h.runVerify('verify-suite-trust.cjs', 'after-trust-enforce'));

  // H: Cleanup
  await h.runStep(r, 'H:health-check', async () => {
    const { status } = await h.httpGet('http://localhost:8080/health', 5000);
    if (status !== 200) throw new Error(`Health ${status}`);
    return { ok: true };
  });
  await h.runStep(r, 'H:verify-after-cleanup', () => h.runVerify('verify-suite-trust.cjs', 'after-cleanup'));

  // I: System Triggers Verification
  await h.runStep(r, 'I:verify-after-system-triggers', () =>
    h.runVerify('verify-suite-overlap-system.cjs', 'after-system-triggers'));

  // I: Overlap Policy
  const createResp = await h.runStep(r, 'I:create-overlap-trigger', () =>
    h.wsSend('main', 'Create a schedule trigger named "overlap-test" on the main team with overlap_policy always-skip and cron "0 0 31 2 *" (never fires) and task "test overlap"'));
  if (createResp) h.flagSemanticCheck('I', 'create-overlap-trigger', 'Does the response confirm a trigger was created with overlap policy?', createResp.final);
  await h.runStep(r, 'I:verify-after-overlap-setup', () =>
    h.runVerify('verify-suite-overlap-system.cjs', 'after-overlap-setup'));

  // I: list_completed_tasks tool test
  const listCompResp = await h.runStep(r, 'I:test-list-completed', () =>
    h.wsSend('main', 'Use list_completed_tasks to show recent completed tasks for the main team'));
  if (listCompResp) h.flagSemanticCheck('I', 'list-completed', 'Does the response list completed tasks or say none found?', listCompResp.final);

  // I: Health check
  await h.runStep(r, 'I:health-check', async () => {
    const { status } = await h.httpGet('http://localhost:8080/health', 5000);
    if (status !== 200) throw new Error(`Health ${status}`);
    return { ok: true };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 2: Teams + Vault [A] — team hierarchy, vault CRUD, delegation
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 2: Teams + Vault [A] ────');

  // A: Memory write
  const memResp = await h.runStep(r, 'A:memory-write', () =>
    h.wsSend('main', 'Remember: Alice is the product manager. Please save this to your memory file.'));
  if (memResp) h.flagSemanticCheck('A', 'memory-write', 'Does the response acknowledge saving information about Alice?', memResp.final);
  await h.runStep(r, 'A:verify-after-memory-write', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-memory-write'));

  // A: Create ops-team
  const opsResp = await h.runStep(r, 'A:create-ops-team', () =>
    h.wsSend('main', 'Create a team called ops-team for monitoring production logs. Accept monitoring and logs topics. Give it credentials: api_key is test-fake-key-value-12345, region is us-east-1'));
  if (opsResp && opsResp.ok) {
    const boot = await h.runStep(r, 'A:wait-ops-team-bootstrap', () => h.waitBootstrap('ops-team'));
    if (boot) opsTeamOk = true;
  }
  await h.runStep(r, 'A:verify-after-team-create', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-team-create'));

  // A: Credential retrieval
  if (opsTeamOk) {
    const credResp = await h.runStep(r, 'A:credential-retrieval', () =>
      h.wsSend('main', 'Ask ops-team to use the vault_get tool to retrieve the api_key credential, and tell me what tool it used.'));
    if (credResp) {
      h.flagSemanticCheck('A', 'credential-retrieval', 'Does the response mention vault_get was used? Does the raw credential (test-fake-key-value-12345) appear?', credResp.final);
    }
  }

  // A: Vault CRUD
  if (opsTeamOk) {
    const setResp = await h.runStep(r, 'A:vault-set', () =>
      h.wsSend('main', 'Ask ops-team to use the vault_set tool to store a key called my_setting with value test-non-secret-value'));
    if (setResp) h.flagSemanticCheck('A', 'vault-set', 'Does the response acknowledge saving my_setting?', setResp.final);

    const getResp = await h.runStep(r, 'A:vault-get', () =>
      h.wsSend('main', 'Ask ops-team to use vault_get to retrieve my_setting'));
    if (getResp) h.flagSemanticCheck('A', 'vault-get', 'Does the response contain test-non-secret-value?', getResp.final);

    const listResp = await h.runStep(r, 'A:vault-list', () =>
      h.wsSend('main', 'Ask ops-team to list all vault entries'));
    if (listResp) h.flagSemanticCheck('A', 'vault-list', 'Does the response list api_key, region, my_setting? Are secret values hidden?', listResp.final);

    const deleteRejectResp = await h.runStep(r, 'A:vault-delete-reject', () =>
      h.wsSend('main', 'Ask ops-team to delete the api_key from vault'));
    if (deleteRejectResp) h.flagSemanticCheck('A', 'vault-delete-reject', 'Does the response indicate rejection because api_key is a secret?', deleteRejectResp.final);

    const deleteOkResp = await h.runStep(r, 'A:vault-delete-ok', () =>
      h.wsSend('main', 'Ask ops-team to delete my_setting from vault'));
    if (deleteOkResp) {
      h.flagSemanticCheck('A', 'vault-delete-ok', 'Does the response confirm my_setting was deleted?', deleteOkResp.final);
      await h.runStep(r, 'A:wait-vault-delete-settle', async () => {
        try { await h.waitTaskComplete('ops-team', '%vault%', 30000); } catch { /* inline path: no task to find */ }
      });
    }
  }
  await h.runStep(r, 'A:verify-after-vault-ops', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-vault-ops'));

  // A: Create team-alpha and team-beta
  const alphaResp = await h.runStep(r, 'A:create-team-alpha', () =>
    h.wsSend('main', 'Create a team called team-alpha for API development. Accept keywords: api, development, coding'));
  if (alphaResp && alphaResp.ok) alphaOk = true;
  await h.runStep(r, 'A:create-team-beta', () =>
    h.wsSend('main', 'Create a team called team-beta for operations and monitoring. Accept keywords: ops, monitoring, deployment'));

  // A: Create alpha-child
  if (alphaOk) {
    await h.runStep(r, 'A:create-alpha-child', () =>
      h.wsSend('main', 'Ask team-alpha to create a child team called alpha-child for frontend work. Accept keywords: frontend, ui'));
    await h.runStep(r, 'A:wait-alpha-child-bootstrap', () => h.waitBootstrap('alpha-child'));
  }
  await h.runStep(r, 'A:verify-after-hierarchy', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-hierarchy'));

  // A: List teams
  const listTeamsResp = await h.runStep(r, 'A:list-teams', () => h.wsSend('main', 'What teams do you have?'));
  if (listTeamsResp) h.flagSemanticCheck('A', 'list-teams', 'Does the response list ops-team, team-alpha, and team-beta?', listTeamsResp.final);

  // A: Delegation
  if (opsTeamOk) {
    await h.runStep(r, 'A:delegation', () => h.wsSend('main', 'Ask ops-team to check deployment status and report back'));
    await h.runStep(r, 'A:wait-delegation-task', () => h.waitTaskComplete('ops-team'));
  }
  await h.runStep(r, 'A:verify-after-delegation', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-delegation'));

  // A: Credential scrubbing
  await h.runStep(r, 'A:verify-after-credentials', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-credentials'));

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 3: Triggers [B Part 1] — create triggers, cron
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 3: Triggers [B Part 1] ────');

  const teamResp = await h.runStep(r, 'B:create-loggly-monitor', () =>
    h.wsSend('main', 'Create a team called loggly-monitor for monitoring Loggly logs. Give it credentials: subdomain is test, api_key is fake-loggly-apikey-9876. Accept keywords: logs, monitoring, loggly.'));
  if (teamResp && teamResp.ok) {
    const boot = await h.runStep(r, 'B:wait-loggly-bootstrap', () => h.waitBootstrap('loggly-monitor'));
    if (boot) logglyOk = true;
  }

  if (logglyOk) {
    const cr = await h.runStep(r, 'B:create-trigger', () =>
      h.wsSend('main', 'Create a schedule trigger for loggly-monitor called loggly-fetch with cron */2 * * * * and task: Fetch recent logs from Loggly using your credentials (subdomain and api_key) and report a summary of any errors found. Use the Loggly Search API.'));
    if (cr) h.flagSemanticCheck('B', 'create-trigger', 'Does the response confirm trigger created?', cr.final);
    const en = await h.runStep(r, 'B:enable-trigger', () =>
      h.wsSend('main', 'Enable the loggly-fetch trigger for loggly-monitor.'));
    if (en) h.flagSemanticCheck('B', 'enable-trigger', 'Does the response confirm trigger enabled?', en.final);
  }
  await h.runStep(r, 'B:verify-after-trigger-setup', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-trigger-setup'));

  await h.runStep(r, 'B:baseline-notifications', async () => {
    const n = await h.wsNotifications('main');
    baselineNotifCount = (n.notifications || []).length;
    return { count: baselineNotifCount };
  });

  if (logglyOk) {
    await h.runStep(r, 'B:wait-cron-fire', () => h.waitTaskCount('loggly-monitor', '%Loggly%', 1, 150000));
    await h.runStep(r, 'B:wait-trigger-task', () => h.waitTaskComplete('loggly-monitor', '%Loggly%'));
  }
  await h.runStep(r, 'B:verify-after-trigger-fire', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-trigger-fire'));
  await h.runStep(r, 'B:verify-after-audit-logs', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-audit-logs'));
  await h.runStep(r, 'B:verify-after-credential-check', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-credential-check'));

  // B: Notification isolation
  if (logglyOk) {
    await h.wsConnect('iso-a');
    await h.wsConnect('iso-b');
    await h.runStep(r, 'B:iso-a-delegation', () => h.wsSend('iso-a', 'Ask loggly-monitor to check recent error logs right now.'));
    await h.runStep(r, 'B:wait-iso-a-task', () => h.waitTaskComplete('loggly-monitor'));
    await h.runStep(r, 'B:iso-a-test-fire', () => h.wsSend('iso-a', 'Test-fire the loggly-fetch trigger for loggly-monitor.'));
    await h.runStep(r, 'B:wait-test-fire-task', () => h.waitTaskComplete('loggly-monitor'));
    await h.runStep(r, 'B:verify-after-notification-test', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-notification-test'));
    await h.runStep(r, 'B:notification-isolation-check', async () => {
      const isoA = await h.wsNotifications('iso-a');
      const isoB = await h.wsNotifications('iso-b');
      const bCount = (isoB.notifications || []).length;
      if (bCount > 0) throw new Error(`iso-b has ${bCount} notifications (should be 0)`);
      return { isoA: (isoA.notifications || []).length, isoB: bCount };
    });
    await h.wsDisconnect('iso-a');
    await h.wsDisconnect('iso-b');
  }

  // Record task count before restart for persistence check in Phase 4
  if (logglyOk) {
    await h.runStep(r, 'B:record-task-count', () => {
      taskCountBefore = h.dbQuery(db =>
        db.prepare("SELECT COUNT(*) AS c FROM task_queue WHERE team_id='loggly-monitor' AND task LIKE '%Loggly%'").get().c);
      return { count: taskCountBefore };
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ─── dockerRestart #1 ───
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── dockerRestart #1 ────');
  await h.dockerRestart();
  await h.wsReconnect('main');

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 4: Persistence [A restart + B restart + B Part 2]
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 4: Persistence [A restart + B restart + B pt2] ────');

  // A restart: Memory persistence
  const recallResp = await h.runStep(r, 'A:restart-memory-recall', () => h.wsSend('main', 'Who is the product manager?'));
  if (recallResp) h.flagSemanticCheck('A', 'restart-recall', 'Does the response mention Alice as the product manager?', recallResp.final);
  await h.runStep(r, 'A:verify-after-restart', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-restart'));

  // B restart: Trigger persistence
  if (logglyOk) {
    await h.runStep(r, 'B:wait-post-restart-cron', () => h.waitTaskCount('loggly-monitor', '%Loggly%', taskCountBefore + 1, 150000));
    await h.runStep(r, 'B:wait-post-restart-task', () => h.waitTaskComplete('loggly-monitor', '%Loggly%'));
  }
  await h.runStep(r, 'B:verify-after-restart', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-restart'));

  // B Part 2: LLM-Based Notify Decisions
  const hcResp = await h.runStep(r, 'B:create-health-checker', () =>
    h.wsSend('main', 'Create a team called health-checker for silent health monitoring. Give it credentials: api_key is fake-health-key-1234. Accept keywords: health, monitoring.'));
  if (hcResp && hcResp.ok) {
    const boot = await h.runStep(r, 'B:wait-health-checker-bootstrap', () => h.waitBootstrap('health-checker'));
    if (boot) healthCheckerOk = true;
  }

  if (healthCheckerOk) {
    await h.runStep(r, 'B:create-quiet-check', () => h.wsSend('main', 'Create a schedule trigger for health-checker called quiet-check with cron */2 * * * * and task: Run a routine background health check. This is a silent monitoring task — there is nothing noteworthy to report unless something is broken.'));
    await h.runStep(r, 'B:enable-quiet-check', () => h.wsSend('main', 'Enable the quiet-check trigger for health-checker.'));
    await h.runStep(r, 'B:create-alert-check', () => h.wsSend('main', 'Create a schedule trigger for health-checker called alert-check with cron */2 * * * * and task: Check the health API status. This is a critical monitoring check — always report the result to the team channel.'));
    await h.runStep(r, 'B:enable-alert-check', () => h.wsSend('main', 'Enable the alert-check trigger for health-checker.'));

    await h.runStep(r, 'B:wait-health-checker-tasks', async () => {
      const start = Date.now();
      while (Date.now() - start < 150000) {
        const rows = h.dbQuery(db => db.prepare("SELECT status FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 2").all());
        if (rows.filter(x => x.status === 'done' || x.status === 'failed').length >= 2) return { completed: true };
        await h.sleep(5000);
      }
      throw new Error('Timeout waiting for health-checker tasks');
    });
  }
  await h.runStep(r, 'B:verify-after-notify-decisions', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-notify-decisions'));

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 5: Skills [G] — skill search/create, shutdown
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 5: Skills [G] ────');

  // G: Tool availability
  const tools = await h.runStep(r, 'G:check-tools-list', () => h.wsSend('main', 'What tools do you have access to? List all of them.'));
  if (tools) h.flagSemanticCheck('G', 'tools-list', 'Does the response mention search_skill_repository?', tools.final);
  await h.runStep(r, 'G:verify-after-tool-check', () => h.runVerify('verify-suite-skill-repo.cjs', 'after-tool-check'));

  // G: Search & adoption
  const team = await h.runStep(r, 'G:create-skill-test-eng', () =>
    h.wsSend('main', 'Create a team called skill-test-eng for engineering tasks. Accept keywords: engineering, code, development.'));
  if (team && team.ok && await h.runStep(r, 'G:wait-skill-test-eng', () => h.waitBootstrap('skill-test-eng'))) skillTeamOk = true;

  if (skillTeamOk) {
    const skill = await h.runStep(r, 'G:search-and-create-skill', () =>
      h.wsSend('main', "Create a frontend code review skill for skill-test-eng. Search the skill repository first to see if there's something we can adapt."));
    if (skill) h.flagSemanticCheck('G', 'skill-search', 'Does the response mention trust signals (install count, source)?', skill.final);
  }
  await h.runStep(r, 'G:verify-after-skill-create', () => h.runVerify('verify-suite-skill-repo.cjs', 'after-skill-create'));

  // G: Graceful degradation
  if (skillTeamOk) {
    const degrade = await h.runStep(r, 'G:graceful-degradation', () =>
      h.wsSend('main', 'Create a deployment checklist skill for skill-test-eng. This should cover pre-deploy checks, rollback procedures, and post-deploy verification.'));
    if (degrade) h.flagSemanticCheck('G', 'degradation', 'Was the skill created without user-facing errors?', degrade.final);
  }

  // G: Cleanup
  if (skillTeamOk) await h.runStep(r, 'G:shutdown-skill-team', () => h.wsSend('main', 'Shut down skill-test-eng.'));
  await h.runStep(r, 'G:verify-after-cleanup', () => h.runVerify('verify-suite-skill-repo.cjs', 'after-cleanup'));

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 6: Stress [C] — concurrent connections
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 6: Stress [C] ────');

  // C: Setup
  await h.runStep(r, 'C:create-stress-team', () =>
    h.wsSend('main', 'Create a team called stress-team for testing. Accept keywords: testing'));
  await h.runStep(r, 'C:insert-baseline-memory', () => {
    h.dbExec(db => db.prepare(
      "INSERT INTO memories (team_name, key, content, type, is_active, created_at, updated_at) VALUES ('main', 'stress-baseline', 'Stress test baseline', 'context', 1, datetime('now'), datetime('now'))"
    ).run());
    return { ok: true };
  });

  // C: Open 5 connections
  for (let i = 1; i <= 5; i++) await h.wsConnect(`s${i}`);

  // C: 5 concurrent messages
  await h.runStep(r, 'C:concurrent-sends', async () => {
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

  // C: Verify
  await h.runStep(r, 'C:verify-after-concurrent', () => h.runVerify('verify-suite-stress.cjs', 'after-concurrent'));
  for (let i = 1; i <= 5; i++) await h.wsDisconnect(`s${i}`);

  // C: Per-socket serialization
  const ser = await h.runStep(r, 'C:serialization-test', async () => {
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

  // ═══════════════════════════════════════════════════════════════════════════
  //  ─── dockerRestart #2 ───
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── dockerRestart #2 ────');
  await h.dockerRestart();
  await h.wsReconnect('main');

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 7: Recovery [C restart]
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 7: Recovery [C restart] ────');

  await h.runStep(r, 'C:verify-after-restart', () => h.runVerify('verify-suite-stress.cjs', 'after-restart'));
  const sanity = await h.runStep(r, 'C:post-restart-sanity', () => h.wsSend('main', 'Hello, are you working?'));
  if (sanity) h.flagSemanticCheck('C', 'post-restart', 'Does the response contain a coherent answer?', sanity.final);

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 8: Context/Threading [E] — topics, idle, rehydration
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 8: Context/Threading [E] ────');

  // Clean topic state from prior phases
  h.dbExec(db => db.prepare("DELETE FROM topics").run());

  // E: Conversation Context
  await h.runStep(r, 'E:interaction-logging', () => h.wsSend('main', 'What tools do you have available?'));

  const rtResp = await h.runStep(r, 'E:create-research-team', () =>
    h.wsSend('main', 'Create a team called research-team for research tasks. Accept keywords: research, analysis.'));
  if (rtResp && rtResp.ok) {
    if (await h.runStep(r, 'E:wait-research-team', () => h.waitBootstrap('research-team'))) researchTeamOk = true;
  }
  if (researchTeamOk) {
    await h.runStep(r, 'E:delegate-to-research', () =>
      h.wsSend('main', 'Ask the research-team to analyze the benefits of microservices vs monolith architecture and report back.'));
    await h.sleep(30000);
  }
  const ctxResp = await h.runStep(r, 'E:context-follow-up', () =>
    h.wsSend('main', 'Can you tell me more about what the research-team found? I want the details of their analysis.'));
  if (ctxResp) h.flagSemanticCheck('E', 'context-awareness', "Does the response show awareness of research-team's microservices/monolith analysis?", ctxResp.final);

  await h.runStep(r, 'E:retention-cleanup-test', () => {
    h.dbExec(db => {
      db.prepare("INSERT INTO channel_interactions (direction, channel_type, channel_id, content_snippet, created_at) VALUES ('inbound', 'test', 'test-cleanup', 'old message', '2020-01-01T00:00:00.000Z')").run();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      db.prepare('DELETE FROM channel_interactions WHERE created_at < ?').run(cutoff);
    });
    return { ok: true };
  });
  await h.runStep(r, 'E:verify-after-interactions', () => h.runVerify('verify-suite-context-threading.cjs', 'after-interactions'));

  // E: Threading
  await h.runStep(r, 'E:topic-first-message', () => h.wsSend('main', 'Research the best Node.js logging libraries and compare them.'));
  await h.runStep(r, 'E:topic-unrelated', () => h.wsSend('main', 'What is the current weather forecast for San Francisco?'));
  const classify = await h.runStep(r, 'E:topic-classification', () =>
    h.wsSend('main', 'Actually, focus only on Winston and Pino for the logging comparison.'));
  if (classify) h.flagSemanticCheck('E', 'topic-classification', 'Was the message routed to the logging topic?', classify.final);
  await h.runStep(r, 'E:verify-after-topic-create', () => h.runVerify('verify-suite-context-threading.cjs', 'after-topic-create'));

  // E: Idle transition
  await h.runStep(r, 'E:wait-idle-transition', async () => {
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
  await h.runStep(r, 'E:topic-rehydration', () => h.wsSend('main', 'Give me the final summary of the logging library comparison.'));

  // E: Fill to limit
  await h.runStep(r, 'E:topic-bookstore', () => h.wsSend('main', 'Design a REST API for a bookstore application.'));
  await h.runStep(r, 'E:topic-fibonacci', () => h.wsSend('main', 'Write a Python script that generates Fibonacci numbers.'));
  await h.runStep(r, 'E:topic-tcp-udp', () => h.wsSend('main', 'Explain the differences between TCP and UDP protocols.'));

  const limit = await h.runStep(r, 'E:topic-limit-test', () => h.wsSend('main', 'Tell me about quantum computing advancements in 2025.'));
  if (limit) h.flagSemanticCheck('E', 'topic-limit', 'Does the response indicate max topics reached?', limit.final);

  await h.runStep(r, 'E:close-topic', () => h.wsSend('main', "Close the weather topic, I'm done with that."));
  await h.runStep(r, 'E:topic-bypass', () => h.wsSend('main', '@bookstore: Add pagination to the list endpoints.'));

  // ═══════════════════════════════════════════════════════════════════════════
  //  ─── dockerRestart #3 ───
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── dockerRestart #3 ────');
  await h.dockerRestart();
  await h.wsReconnect('main');

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 9: Topic Persistence [E restart]
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 9: Topic Persistence [E restart] ────');

  const rehydrate = await h.runStep(r, 'E:post-restart-rehydration', () => h.wsSend('main', 'What was the final verdict on Winston vs Pino?'));
  if (rehydrate) h.flagSemanticCheck('E', 'restart-rehydration', 'Does the response show awareness of previous logging discussion?', rehydrate.final);
  await h.runStep(r, 'E:verify-after-topic-lifecycle', () => h.runVerify('verify-suite-context-threading.cjs', 'after-topic-lifecycle'));

  // ═══════════════════════════════════════════════════════════════════════════
  //  PHASE 10: Cascade Deletion [F] — destructive, always last
  // ═══════════════════════════════════════════════════════════════════════════
  h.log('\n──── Phase 10: Cascade Deletion [F] ────');

  // F: Create hierarchy main -> A1 -> A11
  const a1Resp = await h.runStep(r, 'F:create-A1', () =>
    h.wsSend('main', 'Create a team called A1 for general tasks. Accept keywords: general, tasks.'));
  if (a1Resp && a1Resp.ok && await h.runStep(r, 'F:wait-A1', () => h.waitBootstrap('A1'))) a1Ok = true;

  if (a1Ok) {
    await h.runStep(r, 'F:create-A11', () =>
      h.wsSend('main', 'Ask A1 to create a child team called A11 for subtasks. It should accept keywords: subtasks.'));
    await h.runStep(r, 'F:wait-A11', () => h.waitBootstrap('A11'));
  }
  await h.runStep(r, 'F:verify-after-hierarchy-create', () => h.runVerify('verify-suite-cascade-deletion.cjs', 'after-hierarchy-create'));

  // F: Populate data
  if (a1Ok) {
    await h.runStep(r, 'F:create-A1-trigger', () =>
      h.wsSend('main', 'Create a schedule trigger for A1 called cleanup-check with cron */5 * * * * and task: Check cleanup status.'));
    await h.runStep(r, 'F:delegate-to-A11', () =>
      h.wsSend('main', 'Ask A1 to delegate a task to A11: Run a quick subtask check.'));
  }
  await h.runStep(r, 'F:verify-after-data-populate', () => h.runVerify('verify-suite-cascade-deletion.cjs', 'after-data-populate'));

  // F: Cascade shutdown
  const shut = await h.runStep(r, 'F:cascade-shutdown', () =>
    h.wsSend('main', 'Shut down team A1 with cascade to remove all its child teams too.'));
  if (shut) h.flagSemanticCheck('F', 'cascade-shutdown', 'Does the response confirm shutdown?', shut.final);
  const post = await h.runStep(r, 'F:post-delete-list', () => h.wsSend('main', 'What teams do I have now?'));
  if (post) h.flagSemanticCheck('F', 'post-delete-teams', 'Does the response NOT list A1 or A11?', post.final);
  await h.runStep(r, 'F:verify-after-cascade-delete', () => h.runVerify('verify-suite-cascade-deletion.cjs', 'after-cascade-delete'));

  return r;
};
