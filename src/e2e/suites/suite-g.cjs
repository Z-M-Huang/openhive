'use strict';
const h = require('../run-helpers.cjs');

/** Suite G: Skill Repository */
module.exports = async function suiteG() {
  const r = h.newSuiteResult();
  let skillTeamOk = false;

  // Part 1: Tool availability
  const tools = await h.runStep(r, 'check-tools-list', () => h.wsSend('main', 'What tools do you have access to? List all of them.'));
  if (tools) h.flagSemanticCheck('G', 'tools-list', 'Does the response mention search_skill_repository?', tools.final);
  await h.runStep(r, 'verify-after-tool-check', () => h.runVerify('verify-suite-skill-repo.cjs', 'after-tool-check'));

  // Part 2: Search & adoption
  const team = await h.runStep(r, 'create-skill-test-eng', () =>
    h.wsSend('main', 'Create a team called skill-test-eng for engineering tasks. Accept keywords: engineering, code, development.'));
  if (team && team.ok && await h.runStep(r, 'wait-skill-test-eng', () => h.waitBootstrap('skill-test-eng'))) skillTeamOk = true;

  if (skillTeamOk) {
    const skill = await h.runStep(r, 'search-and-create-skill', () =>
      h.wsSend('main', "Create a frontend code review skill for skill-test-eng. Search the skill repository first to see if there's something we can adapt."));
    if (skill) h.flagSemanticCheck('G', 'skill-search', 'Does the response mention trust signals (install count, source)?', skill.final);
  }
  await h.runStep(r, 'verify-after-skill-create', () => h.runVerify('verify-suite-skill-repo.cjs', 'after-skill-create'));

  // Part 3: Graceful degradation
  if (skillTeamOk) {
    const degrade = await h.runStep(r, 'graceful-degradation', () =>
      h.wsSend('main', 'Create a deployment checklist skill for skill-test-eng. This should cover pre-deploy checks, rollback procedures, and post-deploy verification.'));
    if (degrade) h.flagSemanticCheck('G', 'degradation', 'Was the skill created without user-facing errors?', degrade.final);
  }

  // Part 4: Cleanup
  if (skillTeamOk) await h.runStep(r, 'shutdown-skill-team', () => h.wsSend('main', 'Shut down skill-test-eng.'));
  await h.runStep(r, 'verify-after-cleanup', () => h.runVerify('verify-suite-skill-repo.cjs', 'after-cleanup'));

  return r;
};
