'use strict';
const h = require('../run-helpers.cjs');

/** Suite A: Teams + Hierarchy + Memory */
module.exports = async function suiteA() {
  const r = h.newSuiteResult();
  let opsTeamOk = false, alphaOk = false;

  // 1: Memory write
  const memResp = await h.runStep(r, 'memory-write', () =>
    h.wsSend('main', 'Remember: Alice is the product manager. Please save this to your memory file.'));
  if (memResp) h.flagSemanticCheck('A', 'memory-write', 'Does the response acknowledge saving information about Alice?', memResp.final);
  await h.runStep(r, 'verify-after-memory-write', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-memory-write'));

  // 2: Create ops-team
  const opsResp = await h.runStep(r, 'create-ops-team', () =>
    h.wsSend('main', 'Create a team called ops-team for monitoring production logs. Accept monitoring and logs topics. Give it credentials: api_key is test-fake-key-value-12345, region is us-east-1'));
  if (opsResp && opsResp.ok) {
    const boot = await h.runStep(r, 'wait-ops-team-bootstrap', () => h.waitBootstrap('ops-team'));
    if (boot) opsTeamOk = true;
  }
  await h.runStep(r, 'verify-after-team-create', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-team-create'));

  // 3: Credential retrieval
  if (opsTeamOk) {
    const credResp = await h.runStep(r, 'credential-retrieval', () =>
      h.wsSend('main', 'Ask ops-team to use the get_credential tool to retrieve the api_key credential, and tell me what tool it used.'));
    if (credResp) {
      await h.runStep(r, 'wait-credential-task', () => h.waitTaskComplete('ops-team', '%get_credential%'));
      h.flagSemanticCheck('A', 'credential-retrieval', 'Does the response mention get_credential was used? Does the raw credential (test-fake-key-value-12345) appear?', credResp.final);
    }
  }

  // 4: Create team-alpha and team-beta
  const alphaResp = await h.runStep(r, 'create-team-alpha', () =>
    h.wsSend('main', 'Create a team called team-alpha for API development. Accept keywords: api, development, coding'));
  if (alphaResp && alphaResp.ok) alphaOk = true;
  await h.runStep(r, 'create-team-beta', () =>
    h.wsSend('main', 'Create a team called team-beta for operations and monitoring. Accept keywords: ops, monitoring, deployment'));

  // 5: Create alpha-child
  if (alphaOk) {
    await h.runStep(r, 'create-alpha-child', () =>
      h.wsSend('main', 'Ask team-alpha to create a child team called alpha-child for frontend work. Accept keywords: frontend, ui'));
    await h.runStep(r, 'wait-alpha-child-bootstrap', () => h.waitBootstrap('alpha-child'));
  }
  await h.runStep(r, 'verify-after-hierarchy', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-hierarchy'));

  // 6: List teams
  const listResp = await h.runStep(r, 'list-teams', () => h.wsSend('main', 'What teams do you have?'));
  if (listResp) h.flagSemanticCheck('A', 'list-teams', 'Does the response list ops-team, team-alpha, and team-beta?', listResp.final);

  // 7: Delegation
  if (opsTeamOk) {
    await h.runStep(r, 'delegation', () => h.wsSend('main', 'Ask ops-team to check deployment status and report back'));
    await h.runStep(r, 'wait-delegation-task', () => h.waitTaskComplete('ops-team'));
  }
  await h.runStep(r, 'verify-after-delegation', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-delegation'));

  // 8: Credential scrubbing
  await h.runStep(r, 'verify-after-credentials', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-credentials'));

  // 9: Restart + memory persistence
  await h.dockerRestart();
  await h.wsReconnect('main');
  const recallResp = await h.runStep(r, 'restart-memory-recall', () => h.wsSend('main', 'Who is the product manager?'));
  if (recallResp) h.flagSemanticCheck('A', 'restart-recall', 'Does the response mention Alice as the product manager?', recallResp.final);
  await h.runStep(r, 'verify-after-restart', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-restart'));

  return r;
};
