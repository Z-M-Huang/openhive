'use strict';
const path = require('path');
const fs = require('fs');
const h = require('../run-helpers.cjs');

/** Suite D: Browser */
module.exports = async function suiteD(ctx) {
  if (ctx.skipBrowserSuite) {
    const r = h.newSuiteResult();
    r.status = 'skipped';
    return r;
  }

  const r = h.newSuiteResult();
  let webTeamOk = false, browserOpsOk = false, alphaOk = false, betaOk = false;

  // -- Part 1: Gating --

  const wtResp = await h.runStep(r, 'create-web-team', () =>
    h.wsSend('main', 'Create a team called web-team for web scraping tasks. Accept keywords: web, scraping, browser.'));
  if (wtResp && wtResp.ok) {
    if (await h.runStep(r, 'wait-web-team', () => h.waitBootstrap('web-team'))) webTeamOk = true;
  }
  if (webTeamOk) {
    fs.appendFileSync(path.join(h.RUN_DIR, 'teams/web-team/config.yaml'),
      '\nbrowser:\n  allowed_domains:\n    - "*.example.com"\n    - "example.com"\n  timeout_ms: 30000\n');
    await h.dockerRestart();
    await h.wsReconnect('main');
    const toolResp = await h.runStep(r, 'check-web-team-tools', () =>
      h.wsSend('main', 'Ask web-team to list all its available tools. Focus specifically on any browser-related tools.'));
    if (toolResp) h.flagSemanticCheck('D', 'web-team-tools', 'Does the response mention browser_navigate/browser_snapshot/browser_screenshot?', toolResp.final);
  }

  // No-browser team
  const nbResp = await h.runStep(r, 'create-no-browser-team', () =>
    h.wsSend('main', 'Create a team called no-browser-team for data analysis. Accept keywords: analysis, data.'));
  if (nbResp && nbResp.ok) {
    await h.runStep(r, 'wait-no-browser', () => h.waitBootstrap('no-browser-team'));
    const nbTool = await h.runStep(r, 'check-no-browser-tools', () =>
      h.wsSend('main', 'Ask no-browser-team to list all its available tools, especially any browser tools.'));
    if (nbTool) h.flagSemanticCheck('D', 'no-browser-tools', 'Does the response NOT mention browser_* tools?', nbTool.final);
  }

  // Restricted team
  await h.runStep(r, 'setup-restricted-team', () => {
    const teamDir = path.join(h.RUN_DIR, 'teams/restricted-team');
    for (const sub of ['org-rules', 'team-rules', 'skills', 'subagents']) fs.mkdirSync(path.join(teamDir, sub), { recursive: true });
    fs.writeFileSync(path.join(teamDir, 'config.yaml'), [
      'name: restricted-team', 'description: Team with browser config but restricted tool access',
      'parent: main', 'allowed_tools:', '  - Read', '  - Write', '  - Bash',
      '  - delegate_task', '  - escalate', '  - vault_get',
      'provider_profile: default', 'maxTurns: 50',
      'browser:', '  allowed_domains:', '    - "*.example.com"', '  timeout_ms: 30000', '',
    ].join('\n'));
    h.dbExec(db => db.prepare("INSERT OR IGNORE INTO org_tree (name, parent_id, status) VALUES ('restricted-team', 'main', 'active')").run());
    return { ok: true };
  });
  await h.dockerRestart();
  await h.wsReconnect('main');
  const rr = await h.runStep(r, 'check-restricted-browser', () =>
    h.wsSend('main', 'Ask restricted-team to navigate to example.com using the browser.'));
  if (rr) h.flagSemanticCheck('D', 'restricted-browser', 'Does the response indicate browser tools are denied?', rr.final);

  // Domain allowlist
  if (webTeamOk) {
    const allow = await h.runStep(r, 'navigate-allowed-domain', () =>
      h.wsSend('main', 'Ask web-team to navigate to https://www.example.com and take an accessibility snapshot.'));
    if (allow) h.flagSemanticCheck('D', 'allowed-domain', 'Does the response contain content from example.com?', allow.final);
    const block = await h.runStep(r, 'navigate-blocked-domain', () =>
      h.wsSend('main', 'Ask web-team to navigate to https://www.google.com and take an accessibility snapshot.'));
    if (block) h.flagSemanticCheck('D', 'blocked-domain', 'Is the navigation blocked (domain not in allowlist)?', block.final);
  }
  await h.runStep(r, 'verify-after-gating-setup', () => h.runVerify('verify-suite-browser.cjs', 'after-gating-setup'));

  // -- Part 2: Operations --

  const boResp = await h.runStep(r, 'create-browser-ops', () =>
    h.wsSend('main', 'Create a team called browser-ops for web operations. Accept keywords: web, browse, scrape.'));
  if (boResp && boResp.ok && await h.runStep(r, 'wait-browser-ops', () => h.waitBootstrap('browser-ops'))) {
    fs.appendFileSync(path.join(h.RUN_DIR, 'teams/browser-ops/config.yaml'), '\nbrowser:\n  timeout_ms: 30000\n');
    browserOpsOk = true;
    await h.dockerRestart();
    await h.wsReconnect('main');
  }
  if (browserOpsOk) {
    const nav = await h.runStep(r, 'navigate-snapshot', () =>
      h.wsSend('main', 'Ask browser-ops to navigate to https://example.com and take an accessibility snapshot. Report the page title and main heading text.'));
    if (nav) h.flagSemanticCheck('D', 'navigate-snapshot', 'Does the response contain "Example Domain"?', nav.final);
    const ss = await h.runStep(r, 'screenshot', () =>
      h.wsSend('main', 'Ask browser-ops to navigate to https://example.com and take a screenshot. Describe what the screenshot shows.'));
    if (ss) h.flagSemanticCheck('D', 'screenshot', 'Does the response describe example.com visually?', ss.final);
    const ssrf = await h.runStep(r, 'ssrf-protection', () =>
      h.wsSend('main', 'Ask browser-ops to try navigating to these three URLs one by one and report what happens for each: (1) http://169.254.169.254/latest/meta-data/ (2) http://127.0.0.1:8080/health (3) http://10.0.0.1/ — Report whether each navigation was blocked or succeeded.'));
    if (ssrf) h.flagSemanticCheck('D', 'ssrf', 'Are ALL THREE private IPs blocked?', ssrf.final);
  }
  await h.runStep(r, 'verify-after-browser-ops', () => h.runVerify('verify-suite-browser.cjs', 'after-browser-ops'));

  // -- Part 3: Isolation --

  const saResp = await h.runStep(r, 'create-scraper-alpha', () =>
    h.wsSend('main', 'Create a team called scraper-alpha for scraping site A. Accept keywords: scraping, alpha.'));
  if (saResp && saResp.ok && await h.runStep(r, 'wait-scraper-alpha', () => h.waitBootstrap('scraper-alpha'))) alphaOk = true;
  const sbResp = await h.runStep(r, 'create-scraper-beta', () =>
    h.wsSend('main', 'Create a team called scraper-beta for scraping site B. Accept keywords: scraping, beta.'));
  if (sbResp && sbResp.ok && await h.runStep(r, 'wait-scraper-beta', () => h.waitBootstrap('scraper-beta'))) betaOk = true;

  if (alphaOk) fs.appendFileSync(path.join(h.RUN_DIR, 'teams/scraper-alpha/config.yaml'),
    '\nbrowser:\n  allowed_domains:\n    - "*.example.com"\n    - "example.com"\n  timeout_ms: 30000\n');
  if (betaOk) fs.appendFileSync(path.join(h.RUN_DIR, 'teams/scraper-beta/config.yaml'),
    '\nbrowser:\n  allowed_domains:\n    - "*.example.org"\n    - "example.org"\n  timeout_ms: 30000\n');
  if (alphaOk || betaOk) { await h.dockerRestart(); await h.wsReconnect('main'); }

  if (alphaOk) {
    const resp = await h.runStep(r, 'alpha-navigate-allowed', () => h.wsSend('main', 'Ask scraper-alpha to navigate to https://example.com and report the page title.'));
    if (resp) h.flagSemanticCheck('D', 'alpha-allowed', 'Response mentions "Example Domain"?', resp.final);
  }
  if (betaOk) {
    const resp = await h.runStep(r, 'beta-navigate-blocked', () => h.wsSend('main', 'Ask scraper-beta to navigate to https://example.com and report the page title.'));
    if (resp) h.flagSemanticCheck('D', 'beta-blocked', 'Is navigation BLOCKED (example.com not in beta allowlist)?', resp.final);
  }
  if (alphaOk) await h.runStep(r, 'browser-plus-file-write', () =>
    h.wsSend('main', 'Ask scraper-alpha to navigate to example.com, take an accessibility snapshot, and write a summary of the page to its skills/web-summary.md file.'));
  await h.runStep(r, 'main-no-browser', () => h.wsSend('main', 'Navigate to example.com and tell me what the page says.'));
  await h.runStep(r, 'verify-after-isolation', () => h.runVerify('verify-suite-browser.cjs', 'after-isolation'));

  // -- Part 4: Lifecycle --

  await h.runStep(r, 'wait-idle-cleanup', async () => {
    h.log('Polling for browser idle TTL cleanup (max 420s)...');
    const start = Date.now();
    while (Date.now() - start < 420000) {
      const result = h.run('sudo', ['docker', 'exec', h.CONTAINER, 'sh', '-c', 'ps aux | grep -i "playwright\\|chromium" | grep -v grep | wc -l']);
      const count = parseInt(result.stdout, 10) || 0;
      h.log(`  Browser processes: ${count}`);
      if (count === 0) return { cleaned: true, afterMs: Date.now() - start };
      await h.sleep(30000);
    }
    return { cleaned: false, note: 'Timeout waiting for idle cleanup' };
  });

  if (alphaOk) {
    const resp = await h.runStep(r, 'respawn-after-cleanup', () => h.wsSend('main', 'Ask scraper-alpha to navigate to https://example.com and report the title.'));
    if (resp) h.flagSemanticCheck('D', 'respawn', 'Does response mention "Example Domain" (browser re-spawned)?', resp.final);
  }
  await h.dockerRestart();
  await h.wsReconnect('main');
  if (alphaOk) {
    const resp = await h.runStep(r, 'browser-after-restart', () => h.wsSend('main', 'Ask scraper-alpha to navigate to https://example.com and report the page title.'));
    if (resp) h.flagSemanticCheck('D', 'browser-restart', 'Response mentions "Example Domain"?', resp.final);
  }
  if (alphaOk) await h.runStep(r, 'shutdown-scraper-alpha', () => h.wsSend('main', 'Shut down scraper-alpha'));
  if (betaOk) await h.runStep(r, 'shutdown-scraper-beta', () => h.wsSend('main', 'Shut down scraper-beta'));
  await h.runStep(r, 'verify-after-lifecycle', () => h.runVerify('verify-suite-browser.cjs', 'after-lifecycle'));

  return r;
};
