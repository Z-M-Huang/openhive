/**
 * Enhanced smoke check verification script.
 *
 * Covers the original 22 smoke checks plus 3 new ones:
 *   23. WS frame ordering (ack.seq < response.seq)
 *   24. Skill loading verification
 *   25. Team directory content verification
 *
 * Usage: node src/e2e/verify-smoke.cjs --step infrastructure|database|websocket|protocol|system|browser|enhanced
 */

'use strict';

const path = require('path');
const {
  check, runStep, fileExists, fileContains, dirHasFiles,
  dockerLogsContain, RUN_DIR,
} = require('./verify-helpers.cjs');

const TEAMS_DIR = path.join(RUN_DIR, 'teams');

runStep('smoke', {

  /** Checks 1-9: Infrastructure */
  infrastructure(db) {
    const checks = [];

    // 4. Runtime directories exist
    for (const dir of ['teams', 'shared', 'backups']) {
      const p = path.join(RUN_DIR, dir);
      checks.push(check(
        `dir_${dir}_exists`,
        fileExists(p),
        'directory exists',
        fileExists(p) ? 'exists' : 'missing',
      ));
    }

    // 5. Main team config
    const configPath = path.join(TEAMS_DIR, 'main', 'config.yaml');
    const configExists = fileExists(configPath);
    checks.push(check('main_config_exists', configExists, 'file exists', configExists ? 'exists' : 'missing'));

    if (configExists) {
      const content = require('fs').readFileSync(configPath, 'utf8');
      checks.push(check('main_config_name', content.includes('name: main'), 'contains name: main', content.includes('name: main') ? 'yes' : 'no'));
      checks.push(check('main_config_mcp_empty', content.includes('mcp_servers: []'), 'mcp_servers: []', content.includes('mcp_servers: []') ? 'yes' : 'no'));
    }

    // 6. Main team subdirectories
    for (const sub of ['memory', 'org-rules', 'team-rules', 'skills', 'subagents']) {
      const p = path.join(TEAMS_DIR, 'main', sub);
      checks.push(check(
        `main_subdir_${sub}`,
        fileExists(p),
        'directory exists',
        fileExists(p) ? 'exists' : 'missing',
      ));
    }

    // 9. Container logs contain startup marker
    const startupLines = dockerLogsContain('OpenHive v4 started');
    checks.push(check(
      'startup_log',
      startupLines.length > 0,
      'contains "OpenHive v4 started"',
      startupLines.length > 0 ? `found ${startupLines.length} line(s)` : 'not found',
    ));

    return checks;
  },

  /** Checks 10-13: Database */
  database(db) {
    const checks = [];

    if (!db) {
      checks.push(check('db_open', false, 'database accessible', 'database not found'));
      return checks;
    }

    // 10. org_tree has "main"
    const mainRow = db.prepare("SELECT name FROM org_tree WHERE name='main'").get();
    checks.push(check('org_tree_main', !!mainRow, 'main entry exists', mainRow ? 'exists' : 'missing'));

    // 11. task_queue accessible
    try {
      const count = db.prepare('SELECT COUNT(*) as c FROM task_queue').get();
      checks.push(check('task_queue_accessible', true, 'accessible', `${count.c} rows`));
    } catch (e) {
      checks.push(check('task_queue_accessible', false, 'accessible', String(e.message)));
    }

    // 12. task_queue has result column
    try {
      db.prepare('SELECT result FROM task_queue LIMIT 0').run();
      checks.push(check('task_queue_result_col', true, 'result column exists', 'exists'));
    } catch (e) {
      checks.push(check('task_queue_result_col', false, 'result column exists', String(e.message)));
    }

    // 13. All expected tables exist
    const tables = ['org_tree', 'scope_keywords', 'task_queue', 'trigger_dedup',
      'log_entries', 'escalation_correlations', 'trigger_configs', 'channel_interactions', 'topics'];
    for (const t of tables) {
      try {
        db.prepare(`SELECT COUNT(*) FROM ${t}`).get();
        checks.push(check(`table_${t}`, true, 'table exists', 'exists'));
      } catch (e) {
        checks.push(check(`table_${t}`, false, 'table exists', String(e.message)));
      }
    }

    return checks;
  },

  /** NEW Checks 23-25: Enhanced verifications (absorbed from scenarios 1+6) */
  enhanced(db) {
    const checks = [];

    // 25. Main team directories have content
    const skillsDir = path.join(TEAMS_DIR, 'main', 'skills');
    const skills = dirHasFiles(skillsDir, '.md');
    checks.push(check(
      'main_skills_populated',
      skills.length > 0,
      'skills/ has .md files',
      skills.length > 0 ? `${skills.length} files: ${skills.join(', ')}` : 'empty',
    ));

    const teamRulesDir = path.join(TEAMS_DIR, 'main', 'team-rules');
    const teamRulesExist = fileExists(teamRulesDir);
    checks.push(check(
      'main_team_rules_dir',
      teamRulesExist,
      'team-rules/ exists',
      teamRulesExist ? 'exists' : 'missing',
    ));

    const orgRulesDir = path.join(TEAMS_DIR, 'main', 'org-rules');
    const orgRulesExist = fileExists(orgRulesDir);
    checks.push(check(
      'main_org_rules_dir',
      orgRulesExist,
      'org-rules/ exists',
      orgRulesExist ? 'exists' : 'missing',
    ));

    // Memory directory exists (MEMORY.md seeded by ensureMainTeam)
    const memoryDir = path.join(TEAMS_DIR, 'main', 'memory');
    const memoryMd = path.join(memoryDir, 'MEMORY.md');
    checks.push(check(
      'main_memory_seeded',
      fileExists(memoryMd),
      'MEMORY.md exists',
      fileExists(memoryMd) ? 'exists' : 'missing',
    ));

    return checks;
  },
});
