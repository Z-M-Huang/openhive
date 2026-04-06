'use strict';
const h = require('../run-helpers.cjs');

/** Suite B: Triggers + Notifications */
module.exports = async function suiteB() {
  const r = h.newSuiteResult();
  let logglyOk = false, healthCheckerOk = false;

  // -- Part 1: Trigger Lifecycle --

  const teamResp = await h.runStep(r, 'create-loggly-monitor', () =>
    h.wsSend('main', 'Create a team called loggly-monitor for monitoring Loggly logs. Give it credentials: subdomain is test, api_key is fake-loggly-apikey-9876. Accept keywords: logs, monitoring, loggly.'));
  if (teamResp && teamResp.ok) {
    const boot = await h.runStep(r, 'wait-loggly-bootstrap', () => h.waitBootstrap('loggly-monitor'));
    if (boot) logglyOk = true;
  }

  if (logglyOk) {
    const cr = await h.runStep(r, 'create-trigger', () =>
      h.wsSend('main', 'Create a schedule trigger for loggly-monitor called loggly-fetch with cron */2 * * * * and task: Fetch recent logs from Loggly using your credentials (subdomain and api_key) and report a summary of any errors found. Use the Loggly Search API.'));
    if (cr) h.flagSemanticCheck('B', 'create-trigger', 'Does the response confirm trigger created?', cr.final);
    const en = await h.runStep(r, 'enable-trigger', () =>
      h.wsSend('main', 'Enable the loggly-fetch trigger for loggly-monitor.'));
    if (en) h.flagSemanticCheck('B', 'enable-trigger', 'Does the response confirm trigger enabled?', en.final);
  }
  await h.runStep(r, 'verify-after-trigger-setup', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-trigger-setup'));

  let baselineNotifCount = 0;
  await h.runStep(r, 'baseline-notifications', async () => {
    const n = await h.wsNotifications('main');
    baselineNotifCount = (n.notifications || []).length;
    return { count: baselineNotifCount };
  });

  if (logglyOk) {
    await h.runStep(r, 'wait-cron-fire', () => h.waitTaskCount('loggly-monitor', '%Loggly%', 1, 150000));
    await h.runStep(r, 'wait-trigger-task', () => h.waitTaskComplete('loggly-monitor', '%Loggly%'));
  }
  await h.runStep(r, 'verify-after-trigger-fire', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-trigger-fire'));
  await h.runStep(r, 'verify-after-audit-logs', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-audit-logs'));
  await h.runStep(r, 'verify-after-credential-check', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-credential-check'));

  // Notification isolation
  if (logglyOk) {
    await h.wsConnect('iso-a');
    await h.wsConnect('iso-b');
    await h.runStep(r, 'iso-a-delegation', () => h.wsSend('iso-a', 'Ask loggly-monitor to check recent error logs right now.'));
    await h.runStep(r, 'wait-iso-a-task', () => h.waitTaskComplete('loggly-monitor'));
    await h.runStep(r, 'iso-a-test-fire', () => h.wsSend('iso-a', 'Test-fire the loggly-fetch trigger for loggly-monitor.'));
    await h.runStep(r, 'wait-test-fire-task', () => h.waitTaskComplete('loggly-monitor'));
    await h.runStep(r, 'verify-after-notification-test', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-notification-test'));
    await h.runStep(r, 'notification-isolation-check', async () => {
      const isoA = await h.wsNotifications('iso-a');
      const isoB = await h.wsNotifications('iso-b');
      const bCount = (isoB.notifications || []).length;
      if (bCount > 0) throw new Error(`iso-b has ${bCount} notifications (should be 0)`);
      return { isoA: (isoA.notifications || []).length, isoB: bCount };
    });
    await h.wsDisconnect('iso-a');
    await h.wsDisconnect('iso-b');
  }

  // Restart + trigger persistence
  let taskCountBefore = 0;
  if (logglyOk) {
    await h.runStep(r, 'record-task-count', () => {
      taskCountBefore = h.dbQuery(db =>
        db.prepare("SELECT COUNT(*) AS c FROM task_queue WHERE team_id='loggly-monitor' AND task LIKE '%Loggly%'").get().c);
      return { count: taskCountBefore };
    });
  }
  await h.dockerRestart();
  await h.wsReconnect('main');
  if (logglyOk) {
    await h.runStep(r, 'wait-post-restart-cron', () => h.waitTaskCount('loggly-monitor', '%Loggly%', taskCountBefore + 1, 150000));
    await h.runStep(r, 'wait-post-restart-task', () => h.waitTaskComplete('loggly-monitor', '%Loggly%'));
  }
  await h.runStep(r, 'verify-after-restart', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-restart'));

  // -- Part 2: LLM-Based Notify Decisions --

  const hcResp = await h.runStep(r, 'create-health-checker', () =>
    h.wsSend('main', 'Create a team called health-checker for silent health monitoring. Give it credentials: api_key is fake-health-key-1234. Accept keywords: health, monitoring.'));
  if (hcResp && hcResp.ok) {
    const boot = await h.runStep(r, 'wait-health-checker-bootstrap', () => h.waitBootstrap('health-checker'));
    if (boot) healthCheckerOk = true;
  }

  if (healthCheckerOk) {
    await h.runStep(r, 'create-quiet-check', () => h.wsSend('main', 'Create a schedule trigger for health-checker called quiet-check with cron */2 * * * * and task: Run a routine background health check. This is a silent monitoring task — there is nothing noteworthy to report unless something is broken.'));
    await h.runStep(r, 'enable-quiet-check', () => h.wsSend('main', 'Enable the quiet-check trigger for health-checker.'));
    await h.runStep(r, 'create-alert-check', () => h.wsSend('main', 'Create a schedule trigger for health-checker called alert-check with cron */2 * * * * and task: Check the health API status. This is a critical monitoring check — always report the result to the team channel.'));
    await h.runStep(r, 'enable-alert-check', () => h.wsSend('main', 'Enable the alert-check trigger for health-checker.'));

    await h.runStep(r, 'wait-health-checker-tasks', async () => {
      const start = Date.now();
      while (Date.now() - start < 150000) {
        const rows = h.dbQuery(db => db.prepare("SELECT status FROM task_queue WHERE team_id='health-checker' ORDER BY created_at DESC LIMIT 2").all());
        if (rows.filter(x => x.status === 'completed' || x.status === 'failed').length >= 2) return { completed: true };
        await h.sleep(5000);
      }
      throw new Error('Timeout waiting for health-checker tasks');
    });
  }
  await h.runStep(r, 'verify-after-notify-decisions', () => h.runVerify('verify-suite-triggers-notifications.cjs', 'after-notify-decisions'));

  return r;
};
