/**
 * Suite G: Skill Repository
 * Covers scenario 15
 *
 * Steps:
 *   after-tool-check  — log_entries has search_skill_repository in PreToolUse/PostToolUse context
 *   after-skill-create — skill-test-eng team exists, has skills/ directory with .md files
 *   after-cleanup      — skill-test-eng removed from org_tree, directory gone
 *
 * Usage: node src/e2e/verify-suite-skill-repo.cjs --step <step>
 */

'use strict';

const path = require('path');
const {
  check, runStep, fileExists, dirHasFiles, RUN_DIR,
} = require('./verify-helpers.cjs');

const TEAMS_DIR = path.join(RUN_DIR, 'teams');

runStep('skill-repo', {

  'after-tool-check'(db) {
    const checks = [];

    // PreToolUse entries referencing search_skill_repository
    const preTool = db.prepare(
      "SELECT message, context FROM log_entries WHERE message='PreToolUse' AND context LIKE '%search_skill_repository%' ORDER BY created_at DESC LIMIT 5"
    ).all();
    checks.push(check('pre_tool_skill_repo', preTool.length > 0, 'PreToolUse search_skill_repository', `${preTool.length} entries`));

    // PostToolUse entries referencing search_skill_repository
    const postTool = db.prepare(
      "SELECT message, context FROM log_entries WHERE message='PostToolUse' AND context LIKE '%search_skill_repository%' ORDER BY created_at DESC LIMIT 5"
    ).all();
    checks.push(check('post_tool_skill_repo', postTool.length > 0, 'PostToolUse search_skill_repository', `${postTool.length} entries`));

    return checks;
  },

  'after-skill-create'(db) {
    const checks = [];

    // skill-test-eng exists in org_tree
    const row = db.prepare("SELECT name, parent_id FROM org_tree WHERE name='skill-test-eng'").get();
    checks.push(check('skill_team_exists', !!row, 'skill-test-eng in org_tree', row ? `parent=${row.parent_id}` : 'not found'));

    // Team directory exists
    const teamDir = path.join(TEAMS_DIR, 'skill-test-eng');
    checks.push(check('skill_team_dir', fileExists(teamDir), 'directory exists', fileExists(teamDir) ? 'exists' : 'missing'));

    // skills/ directory exists
    const skillsDir = path.join(teamDir, 'skills');
    checks.push(check('skills_dir_exists', fileExists(skillsDir), 'skills/ directory exists', fileExists(skillsDir) ? 'exists' : 'missing'));

    // skills/ directory has .md files
    const mdFiles = dirHasFiles(skillsDir, '.md');
    checks.push(check('skills_has_md_files', mdFiles.length > 0, '.md files in skills/', mdFiles.length > 0 ? mdFiles.join(', ') : 'none'));

    return checks;
  },

  'after-cleanup'(db) {
    const checks = [];

    // skill-test-eng removed from org_tree
    const row = db.prepare("SELECT name FROM org_tree WHERE name='skill-test-eng'").get();
    checks.push(check('skill_team_removed', !row, 'skill-test-eng not in org_tree', row ? 'still exists' : 'removed'));

    // Directory gone
    const teamDir = path.join(TEAMS_DIR, 'skill-test-eng');
    checks.push(check('skill_team_dir_removed', !fileExists(teamDir), 'directory removed', fileExists(teamDir) ? 'still exists' : 'removed'));

    return checks;
  },
});
