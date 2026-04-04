/**
 * Suite C: Stress & Recovery
 * Covers scenario 5
 *
 * Steps:
 *   after-concurrent  — 5 stress-team-N directories exist, org_tree has entries
 *   after-restart     — teams persist after docker restart, MEMORY.md for main still exists
 *
 * Usage: node src/e2e/verify-suite-stress.cjs --step <step>
 */

'use strict';

const path = require('path');
const {
  check, runStep, fileExists, fileContains, RUN_DIR,
} = require('./verify-helpers.cjs');

const TEAMS_DIR = path.join(RUN_DIR, 'teams');

runStep('stress', {

  'after-concurrent'(db) {
    const checks = [];

    for (let i = 1; i <= 5; i++) {
      const name = `stress-team-${i}`;

      // org_tree entry
      const row = db.prepare('SELECT name, parent_id FROM org_tree WHERE name=?').get(name);
      checks.push(check(`org_tree_${name}`, !!row, `${name} in org_tree`, row ? `parent=${row.parent_id}` : 'not found'));

      // Filesystem directory
      const dir = path.join(TEAMS_DIR, name);
      checks.push(check(`dir_${name}`, fileExists(dir), 'directory exists', fileExists(dir) ? 'exists' : 'missing'));
    }

    // At least 5 teams total (main + 5 stress teams)
    const count = db.prepare("SELECT COUNT(*) AS cnt FROM org_tree WHERE name LIKE 'stress-team-%'").get();
    checks.push(check('stress_team_count', count.cnt >= 5, '>= 5 stress teams', `${count.cnt} teams`));

    return checks;
  },

  'after-restart'(db) {
    const checks = [];

    // All stress teams still in org_tree
    for (let i = 1; i <= 5; i++) {
      const name = `stress-team-${i}`;
      const row = db.prepare('SELECT name FROM org_tree WHERE name=?').get(name);
      checks.push(check(`persist_${name}`, !!row, `${name} persists`, row ? 'exists' : 'missing'));
    }

    // Main team still exists
    const main = db.prepare("SELECT name FROM org_tree WHERE name='main'").get();
    checks.push(check('persist_main', !!main, 'main persists', main ? 'exists' : 'missing'));

    // MEMORY.md for main still exists
    const memPath = path.join(TEAMS_DIR, 'main', 'memory', 'MEMORY.md');
    checks.push(check('main_memory_exists', fileExists(memPath), 'MEMORY.md exists', fileExists(memPath) ? 'exists' : 'missing'));

    // Team directories persist
    for (let i = 1; i <= 5; i++) {
      const name = `stress-team-${i}`;
      const dir = path.join(TEAMS_DIR, name);
      checks.push(check(`persist_dir_${name}`, fileExists(dir), 'directory persists', fileExists(dir) ? 'exists' : 'missing'));
    }

    return checks;
  },
});
