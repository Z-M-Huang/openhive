/**
 * Suite I: Overlap Policy + System Triggers
 *
 * Steps:
 *   after-system-triggers  — dead-letter-scan removed, learning/reflection triggers, schema columns
 *   after-overlap-setup    — overlap-test trigger with always-skip policy
 *
 * Usage: node src/e2e/verify-suite-overlap-system.cjs --step <step>
 */

'use strict';

const { check, runStep } = require('./verify-helpers.cjs');

runStep('overlap-system', {

  'after-system-triggers'(db) {
    const checks = [];

    // Dead-letter scan trigger removed per ADR-38 (replaced by stall detector)
    const dlScan = db.prepare("SELECT * FROM trigger_configs WHERE team='main' AND name='dead-letter-scan'").get();
    checks.push(check('dead_letter_trigger_removed', !dlScan, 'removed', dlScan ? 'still exists' : 'removed'));

    // Learning triggers are active
    const learningTriggers = db.prepare("SELECT * FROM trigger_configs WHERE name='learning-cycle'").all();
    for (const lt of learningTriggers) {
      checks.push(check(`learning_active_${lt.team}`, lt.state === 'active', 'active', lt.state));
    }

    // Reflection triggers exist
    const reflectionTriggers = db.prepare("SELECT * FROM trigger_configs WHERE name='reflection-cycle'").all();
    checks.push(check('reflection_triggers_exist', reflectionTriggers.length > 0, '>0', String(reflectionTriggers.length)));

    // Overlap columns exist on trigger_configs
    const cols = db.prepare("PRAGMA table_info(trigger_configs)").all().map(c => c.name);
    checks.push(check('overlap_policy_column', cols.includes('overlap_policy'), 'exists', cols.includes('overlap_policy') ? 'found' : 'missing'));
    checks.push(check('overlap_count_column', cols.includes('overlap_count'), 'exists', cols.includes('overlap_count') ? 'found' : 'missing'));
    checks.push(check('active_task_id_column', cols.includes('active_task_id'), 'exists', cols.includes('active_task_id') ? 'found' : 'missing'));

    // Plugin tools table exists
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_tools'").get();
    checks.push(check('plugin_tools_table', !!tables, 'exists', tables ? 'found' : 'missing'));

    // Task status migration: no 'completed' rows remain
    const oldStatus = db.prepare("SELECT COUNT(*) as c FROM task_queue WHERE status='completed'").get();
    checks.push(check('no_completed_status', oldStatus.c === 0, '0', String(oldStatus.c)));

    return checks;
  },

  'after-overlap-setup'(db) {
    const checks = [];
    const trigger = db.prepare("SELECT * FROM trigger_configs WHERE name='overlap-test'").get();
    checks.push(check('overlap_trigger_created', !!trigger, 'exists', trigger ? 'found' : 'missing'));
    if (trigger) {
      checks.push(check('overlap_policy_set', trigger.overlap_policy === 'always-skip', 'always-skip', trigger.overlap_policy || 'null'));
    }
    return checks;
  },
});
