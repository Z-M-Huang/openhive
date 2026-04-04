/**
 * Suite A: Teams + Credentials + Hierarchy + Memory
 * Covers scenarios 1 (partial), 2, 3
 *
 * Steps:
 *   after-memory-write     — MEMORY.md contains the remembered fact
 *   after-team-create      — ops-team exists in DB + filesystem
 *   after-credentials      — credential scrubbing (not in logs/responses)
 *   after-hierarchy        — team-alpha, team-beta, alpha-child in org_tree with correct parent_ids
 *   after-delegation       — task_queue has delegated task entry
 *   after-restart          — teams + memory persist across docker restart
 *
 * Usage: node src/e2e/verify-suite-teams-hierarchy.cjs --step <step>
 */

'use strict';

const path = require('path');
const {
  check, runStep, fileExists, fileContains, readConfig,
  dockerLogsAbsent, RUN_DIR,
} = require('./verify-helpers.cjs');

const TEAMS_DIR = path.join(RUN_DIR, 'teams');

runStep('teams-hierarchy', {

  'after-memory-write'(db) {
    const memPath = path.join(TEAMS_DIR, 'main', 'memory', 'MEMORY.md');
    const exists = fileExists(memPath);
    const hasAlice = exists ? fileContains(memPath, 'Alice') : null;

    return [
      check('memory_file_exists', exists, 'MEMORY.md exists', exists ? 'exists' : 'missing'),
      check('memory_contains_alice', !!hasAlice, 'contains "Alice"', hasAlice || 'not found'),
    ];
  },

  'after-team-create'(db) {
    const checks = [];

    // DB: org_tree has ops-team
    const row = db.prepare("SELECT name, parent_id FROM org_tree WHERE name='ops-team'").get();
    checks.push(check('org_tree_ops_team', !!row, 'ops-team in org_tree', row ? `found, parent=${row.parent_id}` : 'not found'));

    // DB: scope_keywords
    const keywords = db.prepare("SELECT keyword FROM scope_keywords WHERE team_id='ops-team'").all().map(r => r.keyword);
    const hasOps = keywords.includes('ops');
    checks.push(check('scope_keywords_ops', hasOps, 'keyword "ops" exists', keywords.join(', ') || 'none'));

    // Filesystem: team directory
    const teamDir = path.join(TEAMS_DIR, 'ops-team');
    checks.push(check('ops_team_dir', fileExists(teamDir), 'directory exists', fileExists(teamDir) ? 'exists' : 'missing'));

    // Filesystem: config.yaml
    const config = readConfig('ops-team');
    checks.push(check('ops_team_config', !!config, 'config.yaml exists', config ? 'exists' : 'missing'));

    // Filesystem: .bootstrapped marker
    const bootstrapped = path.join(TEAMS_DIR, 'ops-team', 'memory', '.bootstrapped');
    checks.push(check('ops_team_bootstrapped', fileExists(bootstrapped), '.bootstrapped exists', fileExists(bootstrapped) ? 'exists' : 'missing'));

    // Config contains credentials
    if (config) {
      checks.push(check('ops_team_has_credentials', config.includes('api_key'), 'config has api_key', config.includes('api_key') ? 'yes' : 'no'));
    }

    return checks;
  },

  'after-credentials'(db) {
    const checks = [];

    // Credential value must NOT appear in docker logs
    const leakFree = dockerLogsAbsent('test-fake-key-value-12345');
    checks.push(check('cred_not_in_logs', leakFree, 'credential absent from logs', leakFree ? 'absent' : 'LEAKED'));

    // Credential value must NOT appear in task_queue result
    const tasks = db.prepare("SELECT result FROM task_queue WHERE team_id='ops-team' AND result IS NOT NULL").all();
    const leaked = tasks.some(t => t.result && t.result.includes('test-fake-key-value-12345'));
    checks.push(check('cred_not_in_task_result', !leaked, 'credential absent from task results', leaked ? 'LEAKED' : 'absent'));

    return checks;
  },

  'after-hierarchy'(db) {
    const checks = [];

    // team-alpha exists
    const alpha = db.prepare("SELECT name, parent_id FROM org_tree WHERE name='team-alpha'").get();
    checks.push(check('org_tree_team_alpha', !!alpha, 'team-alpha exists', alpha ? `parent=${alpha.parent_id}` : 'not found'));

    // team-beta exists
    const beta = db.prepare("SELECT name, parent_id FROM org_tree WHERE name='team-beta'").get();
    checks.push(check('org_tree_team_beta', !!beta, 'team-beta exists', beta ? `parent=${beta.parent_id}` : 'not found'));

    // alpha-child exists with correct parent
    const child = db.prepare("SELECT name, parent_id FROM org_tree WHERE name='alpha-child'").get();
    checks.push(check('org_tree_alpha_child', !!child, 'alpha-child exists', child ? `parent=${child.parent_id}` : 'not found'));

    // alpha-child's parent_id should reference team-alpha's id
    if (alpha && child) {
      const alphaId = db.prepare("SELECT id FROM org_tree WHERE name='team-alpha'").get();
      const correctParent = child.parent_id === alphaId?.id;
      checks.push(check('alpha_child_parent_correct', correctParent, `parent_id=${alphaId?.id}`, `parent_id=${child.parent_id}`));
    }

    // scope_keywords for each team
    for (const team of ['team-alpha', 'team-beta', 'alpha-child']) {
      const kw = db.prepare('SELECT keyword FROM scope_keywords WHERE team_id=?').all(team).map(r => r.keyword);
      checks.push(check(`keywords_${team}`, kw.length > 0, 'has keywords', kw.join(', ') || 'none'));
    }

    // Filesystem: directories exist
    for (const team of ['team-alpha', 'team-beta', 'alpha-child']) {
      const p = path.join(TEAMS_DIR, team);
      checks.push(check(`dir_${team}`, fileExists(p), 'directory exists', fileExists(p) ? 'exists' : 'missing'));
    }

    return checks;
  },

  'after-delegation'(db) {
    const checks = [];

    // task_queue should have at least one entry for ops-team
    const tasks = db.prepare("SELECT id, status, result FROM task_queue WHERE team_id='ops-team' ORDER BY created_at DESC LIMIT 1").get();
    checks.push(check('delegation_task_exists', !!tasks, 'task for ops-team exists', tasks ? `status=${tasks.status}` : 'no tasks'));

    if (tasks) {
      // Task should have completed (or at least have a result)
      const hasResult = !!tasks.result;
      checks.push(check('delegation_has_result', hasResult, 'task has result', hasResult ? `${tasks.result.length} chars` : 'null'));
    }

    return checks;
  },

  'after-restart'(db) {
    const checks = [];

    // All teams still in org_tree
    for (const team of ['main', 'ops-team', 'team-alpha', 'team-beta', 'alpha-child']) {
      const row = db.prepare('SELECT name FROM org_tree WHERE name=?').get(team);
      checks.push(check(`persist_${team}`, !!row, `${team} persists`, row ? 'exists' : 'missing'));
    }

    // Memory persists
    const memPath = path.join(TEAMS_DIR, 'main', 'memory', 'MEMORY.md');
    const hasAlice = fileContains(memPath, 'Alice');
    checks.push(check('persist_memory', !!hasAlice, 'MEMORY.md contains Alice', hasAlice || 'not found'));

    // Team directories persist
    for (const team of ['ops-team', 'team-alpha']) {
      const p = path.join(TEAMS_DIR, team);
      checks.push(check(`persist_dir_${team}`, fileExists(p), 'directory persists', fileExists(p) ? 'exists' : 'missing'));
    }

    return checks;
  },
});
