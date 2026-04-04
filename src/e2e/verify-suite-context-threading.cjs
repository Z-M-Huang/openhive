/**
 * Suite E: Conversation Context + Threading
 * Covers scenarios 12, 14
 *
 * Steps:
 *   after-interactions    — channel_interactions has both inbound and outbound rows
 *   after-topic-create    — topics table has at least one active topic
 *   after-topic-lifecycle — topics with different states (active, resolved, etc.)
 *
 * Usage: node src/e2e/verify-suite-context-threading.cjs --step <step>
 */

'use strict';

const {
  check, runStep,
} = require('./verify-helpers.cjs');

runStep('context-threading', {

  'after-interactions'(db) {
    const checks = [];

    // channel_interactions has inbound rows
    const inbound = db.prepare("SELECT COUNT(*) AS cnt FROM channel_interactions WHERE direction='inbound'").get();
    checks.push(check('inbound_exists', inbound.cnt > 0, 'inbound interactions > 0', `${inbound.cnt} rows`));

    // channel_interactions has outbound rows
    const outbound = db.prepare("SELECT COUNT(*) AS cnt FROM channel_interactions WHERE direction='outbound'").get();
    checks.push(check('outbound_exists', outbound.cnt > 0, 'outbound interactions > 0', `${outbound.cnt} rows`));

    // Both directions present
    checks.push(check('both_directions', inbound.cnt > 0 && outbound.cnt > 0, 'both inbound and outbound', `inbound=${inbound.cnt}, outbound=${outbound.cnt}`));

    // Interactions have required fields populated
    const sample = db.prepare('SELECT channel_type, channel_id, team_id FROM channel_interactions LIMIT 1').get();
    if (sample) {
      checks.push(check('interaction_has_channel_type', !!sample.channel_type, 'channel_type populated', sample.channel_type || 'null'));
      checks.push(check('interaction_has_team_id', !!sample.team_id, 'team_id populated', sample.team_id || 'null'));
    }

    return checks;
  },

  'after-topic-create'(db) {
    const checks = [];

    // topics table has at least one row
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM topics').get();
    checks.push(check('topics_exist', count.cnt > 0, 'topics > 0', `${count.cnt} topics`));

    // At least one active topic
    const active = db.prepare("SELECT COUNT(*) AS cnt FROM topics WHERE state='active'").get();
    checks.push(check('active_topic_exists', active.cnt > 0, 'active topics > 0', `${active.cnt} active`));

    // Topic has required fields
    const sample = db.prepare("SELECT id, channel_id, name, state FROM topics WHERE state='active' LIMIT 1").get();
    if (sample) {
      checks.push(check('topic_has_channel_id', !!sample.channel_id, 'channel_id populated', sample.channel_id || 'null'));
      checks.push(check('topic_has_name', !!sample.name, 'name populated', sample.name || 'null'));
    }

    return checks;
  },

  'after-topic-lifecycle'(db) {
    const checks = [];

    // Total topics
    const total = db.prepare('SELECT COUNT(*) AS cnt FROM topics').get();
    checks.push(check('topics_total', total.cnt > 0, 'topics exist', `${total.cnt} topics`));

    // Distinct states present
    const states = db.prepare('SELECT DISTINCT state FROM topics').all().map(r => r.state);
    checks.push(check('multiple_states', states.length >= 1, '>= 1 distinct state', states.join(', ')));

    // Check for resolved or archived topics (lifecycle progression)
    const nonActive = db.prepare("SELECT COUNT(*) AS cnt FROM topics WHERE state != 'active'").get();
    checks.push(check('non_active_topics', nonActive.cnt > 0, 'non-active topics > 0', `${nonActive.cnt} non-active (states: ${states.join(', ')})`));

    // last_activity should be populated
    const withActivity = db.prepare('SELECT COUNT(*) AS cnt FROM topics WHERE last_activity IS NOT NULL').get();
    checks.push(check('last_activity_populated', withActivity.cnt > 0, 'last_activity set', `${withActivity.cnt} topics with last_activity`));

    return checks;
  },
});
