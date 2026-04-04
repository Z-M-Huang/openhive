/**
 * Suite F: Cascade Deletion
 * Covers scenario 13
 *
 * Steps:
 *   after-hierarchy-create — A1 and A11 exist with correct parent relationship, scope_keywords populated
 *   after-data-populate    — task_queue, trigger_configs have entries for A1/A11
 *   after-cascade-delete   — All 6 tables cleaned for A1/A11, dedup/logs untouched, filesystem gone, main healthy
 *
 * Usage: node src/e2e/verify-suite-cascade-deletion.cjs --step <step>
 */

'use strict';

const path = require('path');
const {
  check, runStep, fileExists, RUN_DIR,
} = require('./verify-helpers.cjs');

const TEAMS_DIR = path.join(RUN_DIR, 'teams');

runStep('cascade-deletion', {

  'after-hierarchy-create'(db) {
    const checks = [];

    // A1 exists in org_tree
    const a1 = db.prepare("SELECT id, name, parent_id FROM org_tree WHERE name='A1'").get();
    checks.push(check('a1_exists', !!a1, 'A1 in org_tree', a1 ? `id=${a1.id}, parent=${a1.parent_id}` : 'not found'));

    // A11 exists in org_tree
    const a11 = db.prepare("SELECT id, name, parent_id FROM org_tree WHERE name='A11'").get();
    checks.push(check('a11_exists', !!a11, 'A11 in org_tree', a11 ? `id=${a11.id}, parent=${a11.parent_id}` : 'not found'));

    // A11's parent_id should reference A1's id
    if (a1 && a11) {
      const correctParent = a11.parent_id === a1.id;
      checks.push(check('a11_parent_is_a1', correctParent, `parent_id=${a1.id}`, `parent_id=${a11.parent_id}`));
    }

    // scope_keywords populated for both
    const kwA1 = db.prepare("SELECT keyword FROM scope_keywords WHERE team_id='A1'").all();
    checks.push(check('a1_keywords', kwA1.length > 0, 'A1 has keywords', kwA1.length > 0 ? kwA1.map(r => r.keyword).join(', ') : 'none'));

    const kwA11 = db.prepare("SELECT keyword FROM scope_keywords WHERE team_id='A11'").all();
    checks.push(check('a11_keywords', kwA11.length > 0, 'A11 has keywords', kwA11.length > 0 ? kwA11.map(r => r.keyword).join(', ') : 'none'));

    // Filesystem directories exist
    checks.push(check('a1_dir', fileExists(path.join(TEAMS_DIR, 'A1')), 'A1 directory exists', fileExists(path.join(TEAMS_DIR, 'A1')) ? 'exists' : 'missing'));
    checks.push(check('a11_dir', fileExists(path.join(TEAMS_DIR, 'A11')), 'A11 directory exists', fileExists(path.join(TEAMS_DIR, 'A11')) ? 'exists' : 'missing'));

    return checks;
  },

  'after-data-populate'(db) {
    const checks = [];

    // task_queue has entries for A1 or A11
    const tasksA1 = db.prepare("SELECT COUNT(*) AS cnt FROM task_queue WHERE team_id='A1'").get();
    const tasksA11 = db.prepare("SELECT COUNT(*) AS cnt FROM task_queue WHERE team_id='A11'").get();
    checks.push(check('tasks_a1', tasksA1.cnt > 0, 'task_queue has A1 entries', `${tasksA1.cnt} rows`));
    checks.push(check('tasks_a11', tasksA11.cnt > 0, 'task_queue has A11 entries', `${tasksA11.cnt} rows`));

    // trigger_configs has entries for A1 or A11
    const trigA1 = db.prepare("SELECT COUNT(*) AS cnt FROM trigger_configs WHERE team='A1'").get();
    const trigA11 = db.prepare("SELECT COUNT(*) AS cnt FROM trigger_configs WHERE team='A11'").get();
    const hasTriggers = trigA1.cnt > 0 || trigA11.cnt > 0;
    checks.push(check('triggers_exist', hasTriggers, 'trigger_configs has A1/A11 entries', `A1=${trigA1.cnt}, A11=${trigA11.cnt}`));

    return checks;
  },

  'after-cascade-delete'(db) {
    const checks = [];
    const targets = ['A1', 'A11'];

    // 1. org_tree: ZERO rows for A1/A11
    const orgRows = db.prepare("SELECT COUNT(*) AS cnt FROM org_tree WHERE name IN ('A1','A11')").get();
    checks.push(check('org_tree_cleaned', orgRows.cnt === 0, '0 org_tree rows', `${orgRows.cnt} rows`));

    // 2. scope_keywords: ZERO rows for A1/A11
    const kwRows = db.prepare("SELECT COUNT(*) AS cnt FROM scope_keywords WHERE team_id IN ('A1','A11')").get();
    checks.push(check('scope_keywords_cleaned', kwRows.cnt === 0, '0 scope_keywords rows', `${kwRows.cnt} rows`));

    // 3. trigger_configs: ZERO rows for A1/A11
    const trigRows = db.prepare("SELECT COUNT(*) AS cnt FROM trigger_configs WHERE team IN ('A1','A11')").get();
    checks.push(check('trigger_configs_cleaned', trigRows.cnt === 0, '0 trigger_configs rows', `${trigRows.cnt} rows`));

    // 4. task_queue: ZERO rows for A1/A11
    const taskRows = db.prepare("SELECT COUNT(*) AS cnt FROM task_queue WHERE team_id IN ('A1','A11')").get();
    checks.push(check('task_queue_cleaned', taskRows.cnt === 0, '0 task_queue rows', `${taskRows.cnt} rows`));

    // 5. escalation_correlations: ZERO rows for A1/A11
    const escRows = db.prepare("SELECT COUNT(*) AS cnt FROM escalation_correlations WHERE source_team IN ('A1','A11') OR target_team IN ('A1','A11')").get();
    checks.push(check('escalation_correlations_cleaned', escRows.cnt === 0, '0 escalation_correlations rows', `${escRows.cnt} rows`));

    // 6. channel_interactions: ZERO rows for A1/A11
    const interRows = db.prepare("SELECT COUNT(*) AS cnt FROM channel_interactions WHERE team_id IN ('A1','A11')").get();
    checks.push(check('channel_interactions_cleaned', interRows.cnt === 0, '0 channel_interactions rows', `${interRows.cnt} rows`));

    // 7. trigger_dedup NOT affected (still has rows)
    const dedupRows = db.prepare('SELECT COUNT(*) AS cnt FROM trigger_dedup').get();
    checks.push(check('trigger_dedup_untouched', dedupRows.cnt > 0, 'trigger_dedup has rows', `${dedupRows.cnt} rows`));

    // 8. log_entries NOT affected (still has rows)
    const logRows = db.prepare('SELECT COUNT(*) AS cnt FROM log_entries').get();
    checks.push(check('log_entries_untouched', logRows.cnt > 0, 'log_entries has rows', `${logRows.cnt} rows`));

    // 9. Filesystem: A1 and A11 directories removed
    checks.push(check('a1_dir_removed', !fileExists(path.join(TEAMS_DIR, 'A1')), 'A1 directory removed', fileExists(path.join(TEAMS_DIR, 'A1')) ? 'still exists' : 'removed'));
    checks.push(check('a11_dir_removed', !fileExists(path.join(TEAMS_DIR, 'A11')), 'A11 directory removed', fileExists(path.join(TEAMS_DIR, 'A11')) ? 'still exists' : 'removed'));

    // 10. Main team still healthy
    const main = db.prepare("SELECT name, status FROM org_tree WHERE name='main'").get();
    checks.push(check('main_team_healthy', !!main, 'main team exists', main ? `status=${main.status}` : 'missing'));

    const mainDir = path.join(TEAMS_DIR, 'main');
    checks.push(check('main_dir_exists', fileExists(mainDir), 'main directory exists', fileExists(mainDir) ? 'exists' : 'missing'));

    return checks;
  },
});
