import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as yamlParse } from 'yaml';
import { ContainerProvisionerImpl } from './provisioner.js';
import { ValidationError, NotFoundError } from '../domain/index.js';
import type { Team, AgentDefinition } from '../domain/index.js';

describe('ContainerProvisionerImpl', () => {
  let tmpDir: string;
  let provisioner: ContainerProvisionerImpl;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'provisioner-test-'));
    provisioner = new ContainerProvisionerImpl(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // scaffoldWorkspace
  // -----------------------------------------------------------------------

  describe('scaffoldWorkspace()', () => {
    it('creates all expected directories and default files', async () => {
      const wsPath = await provisioner.scaffoldWorkspace(tmpDir, 'weather-team');

      expect(wsPath).toBe(join(tmpDir, 'teams', 'weather-team'));

      // Verify directories exist
      const dirs = [
        '.claude/agents',
        '.claude/skills',
        'memory',
        'work/tasks',
        'integrations',
        'plugins/sinks',
        'teams',
      ];
      for (const dir of dirs) {
        const s = await stat(join(wsPath, dir));
        expect(s.isDirectory()).toBe(true);
      }

      // Verify team.yaml
      const teamYaml = await readFile(join(wsPath, 'team.yaml'), 'utf-8');
      const parsed = yamlParse(teamYaml);
      expect(parsed.slug).toBe('weather-team');

      // Verify CLAUDE.md
      const claudeMd = await readFile(join(wsPath, '.claude/CLAUDE.md'), 'utf-8');
      expect(claudeMd).toContain('weather-team');

      // Verify settings.json
      const settings = JSON.parse(await readFile(join(wsPath, '.claude/settings.json'), 'utf-8'));
      expect(settings).toEqual({ allowedTools: [] });
    });

    it('rejects reserved slugs', async () => {
      for (const slug of ['admin', 'system', 'root', 'openhive', 'main']) {
        await expect(provisioner.scaffoldWorkspace(tmpDir, slug))
          .rejects.toThrow(ValidationError);
      }
    });

    it('rejects invalid slug format', async () => {
      await expect(provisioner.scaffoldWorkspace(tmpDir, 'AB'))
        .rejects.toThrow(ValidationError);
    });

    it('rejects parentPath with path traversal outside workspace root', async () => {
      await expect(provisioner.scaffoldWorkspace('/tmp/../../etc', 'test-team'))
        .rejects.toThrow(ValidationError);
    });
  });

  // -----------------------------------------------------------------------
  // writeTeamConfig
  // -----------------------------------------------------------------------

  describe('writeTeamConfig()', () => {
    it('writes team.yaml and round-trips through YAML parse', async () => {
      const wsPath = await provisioner.scaffoldWorkspace(tmpDir, 'cfg-team');

      const team: Team = {
        tid: 'tid-cfg-abc123',
        slug: 'cfg-team',
        leader_aid: 'aid-lead-abc123',
        parent_tid: 'tid-root-000000',
        depth: 1,
        container_id: '',
        health: 'healthy',
        agent_aids: ['aid-mem1-abc123'],
        workspace_path: wsPath,
        created_at: Date.now(),
      };

      await provisioner.writeTeamConfig(wsPath, team);

      const raw = await readFile(join(wsPath, 'team.yaml'), 'utf-8');
      const parsed = yamlParse(raw) as Team;
      expect(parsed.slug).toBe('cfg-team');
      expect(parsed.leader_aid).toBe('aid-lead-abc123');
      expect(parsed.agent_aids).toEqual(['aid-mem1-abc123']);
    });

    it('throws NotFoundError for non-existent workspace', async () => {
      const fakePath = join(tmpDir, 'does-not-exist');
      const team = { slug: 'nope' } as Team;
      await expect(provisioner.writeTeamConfig(fakePath, team))
        .rejects.toThrow(NotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // writeAgentDefinition
  // -----------------------------------------------------------------------

  describe('writeAgentDefinition()', () => {
    it('creates .md file with YAML frontmatter and content body', async () => {
      const wsPath = await provisioner.scaffoldWorkspace(tmpDir, 'agent-team');

      const agent: AgentDefinition = {
        name: 'researcher',
        description: 'Searches for information',
        model: 'sonnet',
        tools: ['web_search', 'read_file'],
        content: 'You are a research assistant.',
      };

      await provisioner.writeAgentDefinition(wsPath, agent);

      const raw = await readFile(join(wsPath, '.claude/agents/researcher.md'), 'utf-8');
      expect(raw).toContain('---');
      expect(raw).toContain('name: researcher');
      expect(raw).toContain('description: Searches for information');
      expect(raw).toContain('model: sonnet');
      expect(raw).toContain('web_search');
      expect(raw).toContain('You are a research assistant.');
    });

    it('omits optional fields when not provided', async () => {
      const wsPath = await provisioner.scaffoldWorkspace(tmpDir, 'minimal-team');

      const agent: AgentDefinition = {
        name: 'helper',
        description: 'A simple helper',
        content: 'Do helpful things.',
      };

      await provisioner.writeAgentDefinition(wsPath, agent);

      const raw = await readFile(join(wsPath, '.claude/agents/helper.md'), 'utf-8');
      expect(raw).not.toContain('model:');
      expect(raw).not.toContain('tools:');
    });
  });

  // -----------------------------------------------------------------------
  // writeSettings
  // -----------------------------------------------------------------------

  describe('writeSettings()', () => {
    it('writes settings.json with correct structure', async () => {
      const wsPath = await provisioner.scaffoldWorkspace(tmpDir, 'settings-team');

      const tools = ['send_message', 'escalate', 'save_memory'];
      await provisioner.writeSettings(wsPath, tools);

      const raw = await readFile(join(wsPath, '.claude/settings.json'), 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed).toEqual({ allowedTools: tools });
    });
  });

  // -----------------------------------------------------------------------
  // deleteWorkspace
  // -----------------------------------------------------------------------

  describe('deleteWorkspace()', () => {
    it('removes directory recursively', async () => {
      const wsPath = await provisioner.scaffoldWorkspace(tmpDir, 'delete-team');

      // Confirm it exists
      const s = await stat(wsPath);
      expect(s.isDirectory()).toBe(true);

      await provisioner.deleteWorkspace(wsPath);

      // Confirm it's gone
      await expect(stat(wsPath)).rejects.toThrow();
    });

    it('rejects path outside workspace root', async () => {
      await expect(provisioner.deleteWorkspace('/tmp'))
        .rejects.toThrow(ValidationError);
    });

    it('throws NotFoundError for non-existent directory', async () => {
      const fakePath = join(tmpDir, 'ghost');
      await expect(provisioner.deleteWorkspace(fakePath))
        .rejects.toThrow(NotFoundError);
    });
  });

  // -----------------------------------------------------------------------
  // archiveWorkspace
  // -----------------------------------------------------------------------

  describe('archiveWorkspace()', () => {
    it('creates a non-empty tar.gz file', async () => {
      const wsPath = await provisioner.scaffoldWorkspace(tmpDir, 'archive-team');
      const archiveFile = join(tmpDir, 'archives', 'archive-team.tar.gz');

      await provisioner.archiveWorkspace(wsPath, archiveFile);

      const s = await stat(archiveFile);
      expect(s.isFile()).toBe(true);
      expect(s.size).toBeGreaterThan(0);
    });
  });
});
