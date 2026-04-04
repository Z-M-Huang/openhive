/**
 * Suite D: Browser Suite
 * Covers scenarios 7, 8, 9, 10
 *
 * Steps:
 *   after-gating-setup  — web-team exists, config.yaml has browser: section
 *   after-browser-ops   — log_entries has browser tool audit entries
 *   after-isolation     — Two browser teams with separate configs, both have browser: section
 *   after-lifecycle     — Browser teams still exist after cleanup/restart
 *
 * Usage: node src/e2e/verify-suite-browser.cjs --step <step>
 */

'use strict';

const path = require('path');
const {
  check, runStep, fileExists, readConfig, RUN_DIR,
} = require('./verify-helpers.cjs');

const TEAMS_DIR = path.join(RUN_DIR, 'teams');

runStep('browser', {

  'after-gating-setup'(db) {
    const checks = [];

    // web-team exists in org_tree
    const row = db.prepare("SELECT name, parent_id FROM org_tree WHERE name='web-team'").get();
    checks.push(check('web_team_exists', !!row, 'web-team in org_tree', row ? `parent=${row.parent_id}` : 'not found'));

    // Filesystem directory
    const dir = path.join(TEAMS_DIR, 'web-team');
    checks.push(check('web_team_dir', fileExists(dir), 'directory exists', fileExists(dir) ? 'exists' : 'missing'));

    // config.yaml has browser: section
    const config = readConfig('web-team');
    checks.push(check('web_team_config', !!config, 'config.yaml exists', config ? 'exists' : 'missing'));
    if (config) {
      const hasBrowser = config.includes('browser:');
      checks.push(check('web_team_browser_config', hasBrowser, 'config has browser: section', hasBrowser ? 'present' : 'missing'));
    }

    return checks;
  },

  'after-browser-ops'(db) {
    const checks = [];

    // log_entries has PreToolUse with browser-related tool names
    const browserTools = ['browser_navigate', 'browser_click', 'browser_screenshot', 'browser_type', 'browser_get_text', 'browser_execute_js', 'browser_wait', 'browser_close'];
    const toolPattern = browserTools.join('|');

    const preTool = db.prepare(
      "SELECT message, context FROM log_entries WHERE message='PreToolUse' AND context LIKE '%browser_%' ORDER BY created_at DESC LIMIT 5"
    ).all();
    checks.push(check('browser_pre_tool_use', preTool.length > 0, 'PreToolUse browser entries', `${preTool.length} entries`));

    const postTool = db.prepare(
      "SELECT message, context FROM log_entries WHERE message='PostToolUse' AND context LIKE '%browser_%' ORDER BY created_at DESC LIMIT 5"
    ).all();
    checks.push(check('browser_post_tool_use', postTool.length > 0, 'PostToolUse browser entries', `${postTool.length} entries`));

    // At least one audit entry should reference a known browser tool
    const allBrowserLogs = db.prepare(
      "SELECT context FROM log_entries WHERE (message='PreToolUse' OR message='PostToolUse') AND context LIKE '%browser_%'"
    ).all();
    const hasKnownTool = allBrowserLogs.some(r => browserTools.some(t => r.context && r.context.includes(t)));
    checks.push(check('browser_known_tool_audit', hasKnownTool, 'audit references known browser tool', hasKnownTool ? 'found' : 'none matched'));

    return checks;
  },

  'after-isolation'(db) {
    const checks = [];

    // Two browser teams exist
    const teams = db.prepare("SELECT name FROM org_tree WHERE name LIKE '%browser%' OR name LIKE '%web%'").all();
    checks.push(check('browser_teams_count', teams.length >= 2, '>= 2 browser teams', `${teams.length} teams: ${teams.map(t => t.name).join(', ')}`));

    // Each team has separate config with browser: section
    const teamNames = teams.map(t => t.name);
    for (const name of teamNames) {
      const config = readConfig(name);
      if (config) {
        const hasBrowser = config.includes('browser:');
        checks.push(check(`${name}_browser_config`, hasBrowser, `${name} has browser: section`, hasBrowser ? 'present' : 'missing'));
      } else {
        checks.push(check(`${name}_config_exists`, false, `${name} config.yaml exists`, 'missing'));
      }
    }

    return checks;
  },

  'after-lifecycle'(db) {
    const checks = [];

    // Browser teams still in org_tree
    const teams = db.prepare("SELECT name FROM org_tree WHERE name LIKE '%browser%' OR name LIKE '%web%'").all();
    checks.push(check('browser_teams_persist', teams.length >= 1, '>= 1 browser team persists', `${teams.length} teams`));

    // Directories persist
    for (const t of teams) {
      const dir = path.join(TEAMS_DIR, t.name);
      checks.push(check(`persist_dir_${t.name}`, fileExists(dir), 'directory persists', fileExists(dir) ? 'exists' : 'missing'));
    }

    return checks;
  },
});
