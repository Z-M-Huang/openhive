/**
 * Suite A: Teams + Credentials + Hierarchy + Memory
 * Covers scenarios 1 (partial), 2, 3
 *
 * Steps:
 *   after-memory-write     — memories table contains the remembered fact
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
  check, runStep, fileExists, readConfig,
  dockerLogsAbsent, RUN_DIR,
} = require('./verify-helpers.cjs');

const TEAMS_DIR = path.join(RUN_DIR, 'teams');

runStep('teams-hierarchy', {

  'after-memory-write'(db) {
    const memories = db.prepare("SELECT * FROM memories WHERE team_name = 'main' AND is_active = 1").all();
    const hasAlice = memories.some(m => m.content && m.content.includes('Alice'));

    return [
      check('memory_exists', memories.length > 0, 'active memories exist', memories.length > 0 ? `${memories.length} memories` : 'none'),
      check('memory_contains_alice', hasAlice, 'contains "Alice"', hasAlice ? 'found' : 'not found'),
    ];
  },

  'after-team-create'(db) {
    const checks = [];

    // DB: org_tree has ops-team
    const row = db.prepare("SELECT name, parent_id FROM org_tree WHERE name='ops-team'").get();
    checks.push(check('org_tree_ops_team', !!row, 'ops-team in org_tree', row ? `found, parent=${row.parent_id}` : 'not found'));

    // DB: scope_keywords
    const keywords = db.prepare("SELECT keyword FROM scope_keywords WHERE team_id='ops-team'").all().map(r => r.keyword);
    const hasRelevant = keywords.some(k => ['ops', 'monitoring', 'logs', 'production'].includes(k));
    checks.push(check('scope_keywords_relevant', hasRelevant, 'has relevant keywords', keywords.join(', ') || 'none'));

    // Filesystem: team directory
    const teamDir = path.join(TEAMS_DIR, 'ops-team');
    checks.push(check('ops_team_dir', fileExists(teamDir), 'directory exists', fileExists(teamDir) ? 'exists' : 'missing'));

    // Filesystem: config.yaml
    const config = readConfig('ops-team');
    checks.push(check('ops_team_config', !!config, 'config.yaml exists', config ? 'exists' : 'missing'));

    // DB: bootstrapped flag
    const bootstrapRow = db.prepare("SELECT bootstrapped FROM org_tree WHERE name='ops-team'").get();
    const isBootstrapped = bootstrapRow && bootstrapRow.bootstrapped === 1;
    checks.push(check('ops_team_bootstrapped', isBootstrapped, 'bootstrapped = 1', isBootstrapped ? 'bootstrapped' : 'not bootstrapped'));

    // Credentials: either in vault (v4.4.0+) or config.yaml (legacy)
    const vaultCreds = db.prepare("SELECT key FROM team_vault WHERE team_name='ops-team' AND key='api_key'").get();
    const configHasCreds = config && config.includes('api_key');
    const hasCreds = !!vaultCreds || configHasCreds;
    checks.push(check('ops_team_has_credentials', hasCreds, 'api_key in vault or config', hasCreds ? (vaultCreds ? 'vault' : 'config') : 'missing'));

    // Vault: credentials migrated to team_vault with is_secret=1
    const vaultRows = db.prepare("SELECT * FROM team_vault WHERE team_name='ops-team'").all();
    const hasVaultKey = vaultRows.some(r => r.key === 'api_key' && r.is_secret === 1);
    const hasVaultRegion = vaultRows.some(r => r.key === 'region' && r.is_secret === 1);
    checks.push(check('vault_migration_api_key', hasVaultKey, 'api_key in vault (is_secret=1)', hasVaultKey ? 'found' : 'missing'));
    checks.push(check('vault_migration_region', hasVaultRegion, 'region in vault (is_secret=1)', hasVaultRegion ? 'found' : 'missing'));

    // Learning: skill file seeded
    const skillPath = path.join(TEAMS_DIR, 'ops-team', 'skills', 'learning-cycle.md');
    checks.push(check('learning_skill_seeded', fileExists(skillPath), 'learning-cycle.md exists', fileExists(skillPath) ? 'exists' : 'missing'));

    return checks;
  },

  'after-vault-ops'(db) {
    const checks = [];

    // After vault_set (my_setting) + vault_delete (my_setting), should have original 2 secret rows
    const rows = db.prepare("SELECT * FROM team_vault WHERE team_name='ops-team'").all();
    checks.push(check('vault_row_count', rows.length === 2, '2 rows (api_key, region)', `${rows.length} rows`));

    // my_setting should be gone (was deleted)
    const hasMySetting = rows.some(r => r.key === 'my_setting');
    checks.push(check('vault_my_setting_deleted', !hasMySetting, 'my_setting absent', hasMySetting ? 'still present' : 'absent'));

    // Secrets still intact and flagged
    checks.push(check('vault_secrets_intact', rows.some(r => r.key === 'api_key'), 'api_key present', rows.some(r => r.key === 'api_key') ? 'present' : 'missing'));
    checks.push(check('vault_secrets_flagged', rows.filter(r => r.is_secret === 1).length === 2, 'both secrets flagged', `${rows.filter(r => r.is_secret === 1).length} flagged`));

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

    // Memory persists in SQLite
    const memories = db.prepare("SELECT * FROM memories WHERE team_name = 'main' AND is_active = 1").all();
    const hasAlice = memories.some(m => m.content && m.content.includes('Alice'));
    checks.push(check('persist_memory', hasAlice, 'memories contain Alice', hasAlice ? 'found' : 'not found'));

    // Team directories persist
    for (const team of ['ops-team', 'team-alpha']) {
      const p = path.join(TEAMS_DIR, team);
      checks.push(check(`persist_dir_${team}`, fileExists(p), 'directory persists', fileExists(p) ? 'exists' : 'missing'));
    }

    return checks;
  },
});
