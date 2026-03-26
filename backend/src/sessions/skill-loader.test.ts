/**
 * Skill and Subagent Loader
 *
 * Tests: loadSkillsContent and loadSubagents for empty/populated directories
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';

import { loadSkillsContent, loadSubagents } from './skill-loader.js';

// ── Skill and Subagent Loader ────────────────────────────────────────────

describe('Skill and Subagent Loader', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openhive-l6-skills-'));
    mkdirSync(join(dir, 'teams', 'test-team', 'skills'), { recursive: true });
    mkdirSync(join(dir, 'teams', 'test-team', 'subagents'), { recursive: true });
  });

  it('returns empty string when skills/ is empty', () => {
    expect(loadSkillsContent(dir, 'test-team')).toBe('');
  });

  it('returns concatenated content with header when skills/ has .md files', () => {
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'deploy.md'), '# Deploy\nStep 1');
    writeFileSync(join(dir, 'teams', 'test-team', 'skills', 'review.md'), '# Review\nStep A');
    const result = loadSkillsContent(dir, 'test-team');
    expect(result).toContain('--- Skills ---');
    expect(result).toContain('# Deploy');
    expect(result).toContain('# Review');
  });

  it('returns empty record when subagents/ is empty', () => {
    expect(Object.keys(loadSubagents(dir, 'test-team'))).toHaveLength(0);
  });

  it('parses subagent .md format', () => {
    const content = '# Agent: Devops\n## Role\nHandles deployments\n## Skills\n- deploy — run deploys\n- rollback — undo deploys\n';
    writeFileSync(join(dir, 'teams', 'test-team', 'subagents', 'devops.md'), content);
    const agents = loadSubagents(dir, 'test-team');
    const keys = Object.keys(agents);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toBe('Devops');
    const agent = agents['Devops'];
    expect(agent.description).toBe('Handles deployments');
    expect(agent.skills).toEqual(['deploy', 'rollback']);
  });
});
