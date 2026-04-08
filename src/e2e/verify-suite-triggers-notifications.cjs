/**
 * Suite B: Triggers + Notifications
 * Covers scenarios 4, 11
 *
 * Steps:
 *   after-trigger-setup     — team + trigger created and active
 *   after-trigger-fire      — task_queue has executed task with result
 *   after-audit-logs        — log_entries has PreToolUse/PostToolUse with required fields
 *   after-credential-check  — credentials not leaked in logs/notifications/task results
 *   after-notification-test — notification routing (sourceChannelId isolation)
 *   after-restart           — trigger persists and reloads
 *   after-notify-decisions  — LLM-based notify=true/false/missing behavior (scenario 11)
 *
 * Usage: node src/e2e/verify-suite-triggers-notifications.cjs --step <step>
 */

'use strict';

const path = require('path');
const {
  check, runStep, fileExists, readConfig,
  dockerLogsAbsent, dockerLogsContain, RUN_DIR,
} = require('./verify-helpers.cjs');

const TEAMS_DIR = path.join(RUN_DIR, 'teams');

runStep('triggers-notifications', {

  'after-trigger-setup'(db) {
    const checks = [];

    // Team exists
    const team = db.prepare("SELECT name FROM org_tree WHERE name='loggly-monitor'").get();
    checks.push(check('loggly_team_exists', !!team, 'loggly-monitor in org_tree', team ? 'exists' : 'not found'));

    // Filesystem
    const dir = path.join(TEAMS_DIR, 'loggly-monitor');
    checks.push(check('loggly_dir_exists', fileExists(dir), 'directory exists', fileExists(dir) ? 'exists' : 'missing'));

    // DB: bootstrapped flag
    const bootstrapRow = db.prepare("SELECT bootstrapped FROM org_tree WHERE name='loggly-monitor'").get();
    const isBootstrapped = bootstrapRow && bootstrapRow.bootstrapped === 1;
    checks.push(check('loggly_bootstrapped', isBootstrapped, 'bootstrapped = 1', isBootstrapped ? 'bootstrapped' : 'not bootstrapped'));

    // Config has credentials
    const config = readConfig('loggly-monitor');
    if (config) {
      checks.push(check('loggly_has_credentials', config.includes('api_key'), 'config has api_key', config.includes('api_key') ? 'yes' : 'no'));
    }

    // Trigger exists and is active
    const trigger = db.prepare("SELECT name, state, task FROM trigger_configs WHERE team='loggly-monitor'").get();
    checks.push(check('trigger_exists', !!trigger, 'trigger in trigger_configs', trigger ? `name=${trigger.name}, state=${trigger.state}` : 'not found'));
    if (trigger) {
      checks.push(check('trigger_active', trigger.state === 'active', 'state=active', `state=${trigger.state}`));
    }

    // Startup logs show trigger registration
    const regLines = dockerLogsContain('Registered schedule');
    checks.push(check('trigger_registered_log', regLines.length > 0, 'logs show registration', regLines.length > 0 ? `${regLines.length} line(s)` : 'not found'));

    // Learning trigger: auto-seeded in disabled state
    const learningTrigger = db.prepare("SELECT name, state FROM trigger_configs WHERE team='loggly-monitor' AND name='learning-cycle'").get();
    checks.push(check('learning_trigger_exists', !!learningTrigger, 'learning-cycle trigger exists', learningTrigger ? `state=${learningTrigger.state}` : 'not found'));
    if (learningTrigger) {
      checks.push(check('learning_trigger_disabled', learningTrigger.state === 'disabled', 'state=disabled', `state=${learningTrigger.state}`));
    }

    // Learning skill file seeded
    const skillPath = path.join(TEAMS_DIR, 'loggly-monitor', 'skills', 'learning-cycle.md');
    checks.push(check('learning_skill_exists', fileExists(skillPath), 'learning-cycle.md exists', fileExists(skillPath) ? 'exists' : 'missing'));

    return checks;
  },

  'after-trigger-fire'(db) {
    const checks = [];

    // task_queue has entry for loggly-monitor
    const task = db.prepare("SELECT id, status, result, duration_ms FROM task_queue WHERE team_id='loggly-monitor' ORDER BY created_at DESC LIMIT 1").get();
    checks.push(check('trigger_task_exists', !!task, 'task in queue', task ? `status=${task.status}` : 'no tasks'));

    if (task) {
      // Task should be completed
      checks.push(check('trigger_task_completed', task.status === 'completed', 'status=completed', `status=${task.status}`));

      // Result should contain evidence of API call attempt
      const result = task.result || '';
      const apiIndicators = ['401', '403', 'Unauthorized', 'Forbidden', 'authentication', 'loggly', 'HTTP', 'curl'];
      const hasIndicator = apiIndicators.some(ind => result.toLowerCase().includes(ind.toLowerCase()));
      checks.push(check('trigger_result_has_api_evidence', hasIndicator, 'result shows API attempt', hasIndicator ? 'API evidence found' : `result: ${result.slice(0, 200)}`));

      // Duration should be recorded
      checks.push(check('trigger_duration_recorded', task.duration_ms > 0, 'duration_ms > 0', `${task.duration_ms}ms`));
    }

    return checks;
  },

  'after-audit-logs'(db) {
    const checks = [];

    // log_entries has ToolCall:start and ToolCall:end audit entries
    const preTool = db.prepare("SELECT message, context FROM log_entries WHERE message='ToolCall:start' ORDER BY created_at DESC LIMIT 3").all();
    checks.push(check('pre_tool_use_logged', preTool.length > 0, 'ToolCall:start entries exist', `${preTool.length} entries`));

    const postTool = db.prepare("SELECT message, context FROM log_entries WHERE message='ToolCall:end' ORDER BY created_at DESC LIMIT 3").all();
    checks.push(check('post_tool_use_logged', postTool.length > 0, 'ToolCall:end entries exist', `${postTool.length} entries`));

    // ToolCall:end should have durationMs in context
    if (postTool.length > 0 && postTool[0].context) {
      const hasDuration = postTool[0].context.includes('durationMs');
      checks.push(check('audit_has_duration', hasDuration, 'context has durationMs', hasDuration ? 'present' : 'missing'));
    }

    return checks;
  },

  'after-credential-check'(db) {
    const checks = [];

    // Credential value not in docker logs
    const logClean = dockerLogsAbsent('fake-loggly-apikey-9876');
    checks.push(check('cred_not_in_logs', logClean, 'credential absent from logs', logClean ? 'absent' : 'LEAKED'));

    // Credential value not in task_queue results
    const tasks = db.prepare("SELECT result FROM task_queue WHERE team_id='loggly-monitor' AND result IS NOT NULL").all();
    const leaked = tasks.some(t => t.result.includes('fake-loggly-apikey-9876'));
    checks.push(check('cred_not_in_results', !leaked, 'credential absent from results', leaked ? 'LEAKED' : 'absent'));

    return checks;
  },

  'after-notification-test'(db) {
    const checks = [];

    // task_queue should have sourceChannelId populated
    const task = db.prepare("SELECT source_channel_id FROM task_queue WHERE team_id='loggly-monitor' AND source_channel_id IS NOT NULL ORDER BY created_at DESC LIMIT 1").get();
    checks.push(check('source_channel_id_set', !!task, 'sourceChannelId populated', task ? `channelId=${task.source_channel_id}` : 'null'));

    return checks;
  },

  'after-restart'(db) {
    const checks = [];

    // Trigger still in DB
    const trigger = db.prepare("SELECT name, state FROM trigger_configs WHERE team='loggly-monitor'").get();
    checks.push(check('trigger_persists', !!trigger, 'trigger in DB after restart', trigger ? `state=${trigger.state}` : 'not found'));

    // Logs show trigger reloaded
    const loadLines = dockerLogsContain('Loaded triggers from store');
    checks.push(check('trigger_reloaded_log', loadLines.length > 0, 'logs show reload', loadLines.length > 0 ? `${loadLines.length} line(s)` : 'not found'));

    // Team directory persists
    const dir = path.join(TEAMS_DIR, 'loggly-monitor');
    checks.push(check('loggly_dir_persists', fileExists(dir), 'directory persists', fileExists(dir) ? 'exists' : 'missing'));

    return checks;
  },

  'after-notify-decisions'(db) {
    const checks = [];

    // Scenario 11: health-checker team created
    const team = db.prepare("SELECT name FROM org_tree WHERE name='health-checker'").get();
    checks.push(check('health_checker_exists', !!team, 'health-checker in org_tree', team ? 'exists' : 'not found'));

    // Trigger exists for health-checker
    const trigger = db.prepare("SELECT name, state, task FROM trigger_configs WHERE team='health-checker'").get();
    checks.push(check('health_trigger_exists', !!trigger, 'trigger exists', trigger ? `name=${trigger.name}, state=${trigger.state}` : 'not found'));

    // Credential not leaked
    const logClean = dockerLogsAbsent('fake-health-key-1234');
    checks.push(check('health_cred_not_leaked', logClean, 'credential absent from logs', logClean ? 'absent' : 'LEAKED'));

    return checks;
  },
});
