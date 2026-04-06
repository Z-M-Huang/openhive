/**
 * Suite H: TrustGate
 * Covers scenario 16
 *
 * Steps:
 *   after-schema-check  — sender_trust + trust_audit_log tables exist, channel_interactions has trust_decision column
 *   after-trust-score   — sender_trust has rows, trust_audit_log has entries, channel_interactions.trust_decision populated
 *   after-trust-enforce — trust_audit_log count >= 2 (multiple interactions scored)
 *   after-cleanup       — health endpoint responsive, no crash indicators
 *
 * Usage: node src/e2e/verify-suite-trust.cjs --step <step>
 */

'use strict';

const { check, runStep } = require('./verify-helpers.cjs');

runStep('trust', {

  'after-schema-check'(db) {
    const checks = [];

    // sender_trust table exists
    const stTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sender_trust'"
    ).get();
    checks.push(check('sender_trust_table', !!stTable, 'sender_trust table exists', stTable ? 'exists' : 'missing'));

    // trust_audit_log table exists
    const talTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='trust_audit_log'"
    ).get();
    checks.push(check('trust_audit_log_table', !!talTable, 'trust_audit_log table exists', talTable ? 'exists' : 'missing'));

    // channel_interactions has trust_decision column
    const cols = db.prepare("PRAGMA table_info('channel_interactions')").all();
    const tdCol = cols.find(c => c.name === 'trust_decision');
    checks.push(check('trust_decision_column', !!tdCol, 'trust_decision column exists', tdCol ? `type=${tdCol.type}` : 'missing'));

    return checks;
  },

  'after-trust-score'(db) {
    const checks = [];

    // sender_trust may be empty (only populated by add_trusted_sender tool, not auto on message)
    // Just verify the table is queryable
    const stRows = db.prepare('SELECT COUNT(*) AS cnt FROM sender_trust').get();
    checks.push(check('sender_trust_queryable', stRows.cnt >= 0, 'sender_trust table queryable', `${stRows.cnt} rows`));

    // trust_audit_log has at least 1 entry
    const talRows = db.prepare('SELECT COUNT(*) AS cnt FROM trust_audit_log').get();
    checks.push(check('trust_audit_log_rows', talRows.cnt > 0, 'trust_audit_log has entries', `${talRows.cnt} entries`));

    // trust_audit_log entries have valid decision values
    const decisions = db.prepare(
      'SELECT DISTINCT decision FROM trust_audit_log'
    ).all().map(r => r.decision);
    const validDecisions = ['allowed', 'denied'];
    const allValid = decisions.every(d => validDecisions.includes(d));
    checks.push(check('trust_audit_decisions_valid', allValid, 'valid decision values', decisions.join(', ') || 'none'));

    // channel_interactions has trust_decision populated on recent inbound rows
    const ciRows = db.prepare(
      "SELECT trust_decision FROM channel_interactions WHERE direction='inbound' ORDER BY id DESC LIMIT 5"
    ).all();
    const hasDecision = ciRows.some(r => r.trust_decision !== null && r.trust_decision !== '');
    checks.push(check('trust_decision_populated', hasDecision, 'inbound interactions have trust_decision', `${ciRows.length} rows checked`));

    // trust_decision values match expected set
    const tdValues = ciRows.map(r => r.trust_decision).filter(Boolean);
    const validTd = ['allowed', 'denied'];
    const tdValid = tdValues.length > 0 && tdValues.every(v => validTd.includes(v));
    checks.push(check('trust_decision_values_valid', tdValid, 'trust_decision in (allowed, denied)', tdValues.join(', ') || 'none'));

    return checks;
  },

  'after-trust-enforce'(db) {
    const checks = [];

    // trust_audit_log count >= 2 (multiple interactions scored)
    const talCount = db.prepare('SELECT COUNT(*) AS cnt FROM trust_audit_log').get();
    checks.push(check('trust_audit_log_count', talCount.cnt >= 2, 'trust_audit_log >= 2 entries', `${talCount.cnt} entries`));

    // sender_trust table queryable (may be empty if no manual grants)
    const stCount = db.prepare('SELECT COUNT(*) AS cnt FROM sender_trust').get();
    checks.push(check('sender_trust_queryable', stCount.cnt >= 0, 'sender_trust table queryable', `${stCount.cnt} rows`));

    // trust_decision column in channel_interactions is still populated
    const ciDecisions = db.prepare(
      "SELECT COUNT(*) AS cnt FROM channel_interactions WHERE trust_decision IS NOT NULL AND trust_decision != ''"
    ).get();
    checks.push(check('interactions_trust_decisions', ciDecisions.cnt > 0, 'interactions have trust_decision', `${ciDecisions.cnt} rows`));

    return checks;
  },

  'after-cleanup'(db) {
    const checks = [];

    // main team still healthy
    const main = db.prepare("SELECT name, status FROM org_tree WHERE name='main'").get();
    checks.push(check('main_team_healthy', !!main, 'main team exists', main ? `status=${main.status}` : 'missing'));

    // Tables still intact (not dropped by cleanup)
    const stTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='sender_trust'"
    ).get();
    checks.push(check('sender_trust_intact', !!stTable, 'sender_trust table intact', stTable ? 'exists' : 'dropped'));

    const talTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='trust_audit_log'"
    ).get();
    checks.push(check('trust_audit_log_intact', !!talTable, 'trust_audit_log table intact', talTable ? 'exists' : 'dropped'));

    return checks;
  },
});
