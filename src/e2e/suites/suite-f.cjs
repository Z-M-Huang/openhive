'use strict';
const h = require('../run-helpers.cjs');

/** Suite F: Cascade Deletion */
module.exports = async function suiteF() {
  const r = h.newSuiteResult();
  let a1Ok = false;

  // Part 1: Create hierarchy main -> A1 -> A11
  const a1Resp = await h.runStep(r, 'create-A1', () =>
    h.wsSend('main', 'Create a team called A1 for general tasks. Accept keywords: general, tasks.'));
  if (a1Resp && a1Resp.ok && await h.runStep(r, 'wait-A1', () => h.waitBootstrap('A1'))) a1Ok = true;

  if (a1Ok) {
    await h.runStep(r, 'create-A11', () =>
      h.wsSend('main', 'Ask A1 to create a child team called A11 for subtasks. It should accept keywords: subtasks.'));
    await h.runStep(r, 'wait-A11', () => h.waitBootstrap('A11'));
  }
  await h.runStep(r, 'verify-after-hierarchy-create', () => h.runVerify('verify-suite-cascade-deletion.cjs', 'after-hierarchy-create'));

  // Part 2: Populate data
  if (a1Ok) {
    await h.runStep(r, 'create-A1-trigger', () =>
      h.wsSend('main', 'Create a schedule trigger for A1 called cleanup-check with cron */5 * * * * and task: Check cleanup status.'));
    await h.runStep(r, 'delegate-to-A11', () =>
      h.wsSend('main', 'Ask A1 to delegate a task to A11: Run a quick subtask check.'));
  }
  await h.runStep(r, 'verify-after-data-populate', () => h.runVerify('verify-suite-cascade-deletion.cjs', 'after-data-populate'));

  // Part 3: Cascade shutdown
  const shut = await h.runStep(r, 'cascade-shutdown', () =>
    h.wsSend('main', 'Shut down team A1 with cascade to remove all its child teams too.'));
  if (shut) h.flagSemanticCheck('F', 'cascade-shutdown', 'Does the response confirm shutdown?', shut.final);
  const post = await h.runStep(r, 'post-delete-list', () => h.wsSend('main', 'What teams do I have now?'));
  if (post) h.flagSemanticCheck('F', 'post-delete-teams', 'Does the response NOT list A1 or A11?', post.final);
  await h.runStep(r, 'verify-after-cascade-delete', () => h.runVerify('verify-suite-cascade-deletion.cjs', 'after-cascade-delete'));

  return r;
};
