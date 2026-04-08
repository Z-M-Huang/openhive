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
      h.wsSend('main', 'Ask ops-team to use the vault_get tool to retrieve the api_key credential, and tell me what tool it used.'));
    if (credResp) {
      h.flagSemanticCheck('A', 'credential-retrieval', 'Does the response mention vault_get was used? Does the raw credential (test-fake-key-value-12345) appear?', credResp.final);
    }
  }

  // 4: Vault CRUD — set, get, list, delete-reject, delete-ok
  // Note: main uses query_team (inline) for these, not delegate_task, so no task_queue polling needed.
  if (opsTeamOk) {
    const setResp = await h.runStep(r, 'vault-set', () =>
      h.wsSend('main', 'Ask ops-team to use the vault_set tool to store a key called my_setting with value test-non-secret-value'));
    if (setResp) h.flagSemanticCheck('A', 'vault-set', 'Does the response acknowledge saving my_setting?', setResp.final);

    const getResp = await h.runStep(r, 'vault-get', () =>
      h.wsSend('main', 'Ask ops-team to use vault_get to retrieve my_setting'));
    if (getResp) h.flagSemanticCheck('A', 'vault-get', 'Does the response contain test-non-secret-value?', getResp.final);

    const listResp = await h.runStep(r, 'vault-list', () =>
      h.wsSend('main', 'Ask ops-team to list all vault entries'));
    if (listResp) h.flagSemanticCheck('A', 'vault-list', 'Does the response list api_key, region, my_setting? Are secret values hidden?', listResp.final);

    const deleteRejectResp = await h.runStep(r, 'vault-delete-reject', () =>
      h.wsSend('main', 'Ask ops-team to delete the api_key from vault'));
    if (deleteRejectResp) h.flagSemanticCheck('A', 'vault-delete-reject', 'Does the response indicate rejection because api_key is a secret?', deleteRejectResp.final);

    const deleteOkResp = await h.runStep(r, 'vault-delete-ok', () =>
      h.wsSend('main', 'Ask ops-team to delete my_setting from vault'));
    if (deleteOkResp) {
      h.flagSemanticCheck('A', 'vault-delete-ok', 'Does the response confirm my_setting was deleted?', deleteOkResp.final);
      // AI may delegate (async) instead of query (inline) — wait for any pending ops-team tasks
      await h.runStep(r, 'wait-vault-delete-settle', async () => {
        try { await h.waitTaskComplete('ops-team', '%vault%', 30000); } catch { /* inline path: no task to find */ }
      });
    }
  }
  await h.runStep(r, 'verify-after-vault-ops', () => h.runVerify('verify-suite-teams-hierarchy.cjs', 'after-vault-ops'));

  // 5: Create team-alpha and team-beta
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
