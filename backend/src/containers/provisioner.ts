/**
 * Container provisioner — workspace scaffolding and team provisioning.
 *
 * Provides the {@link ContainerProvisioner} interface for creating, configuring,
 * and tearing down team workspaces. Each team workspace is a self-contained
 * directory tree that gets bind-mounted into the team's Docker container at
 * `/app/workspace`.
 *
 * The provisioner scaffolds the workspace structure and places all agent
 * definitions inside the team workspace.
 *
 * ## Workspace Directory Structure
 *
 * When {@link scaffoldWorkspace} is called, it creates the following directory
 * tree under `<parentPath>/teams/<teamSlug>/`:
 *
 * ```
 * <teamSlug>/
 * ├── team.yaml                    # Team configuration (agents, MCP servers)
 * ├── .claude/
 * │   ├── CLAUDE.md                # Team-specific instructions for Claude
 * │   ├── settings.json            # Allowed tools configuration
 * │   ├── agents/                  # Agent definition files (<name>.md)
 * │   └── skills/                  # Skill definition files (<name>/SKILL.md)
 * ├── memory/                      # Agent memory storage
 * ├── integrations/                # Integration configurations
 * ├── plugins/
 * │   └── sinks/                   # Log sink plugins
 * ├── teams/                       # Child team workspaces (recursive nesting)
 * └── work/
 *     └── tasks/                   # Task-scoped working directories
 * ```
 *
 * This structure mirrors the recursive workspace nesting described in the
 * architecture: `.run/workspace/teams/<slug>/teams/<child>/teams/<grandchild>/`.
 * Each level follows the same layout, enabling arbitrary depth team hierarchies.
 *
 * ## Security Considerations
 *
 * - All paths are validated to prevent path traversal attacks
 * - The `parentPath` must resolve to a directory within the configured workspace root
 * - Team slugs are validated against the slug format before creating directories
 * - Workspace deletion verifies the path is within the workspace tree before removing
 *
 * @module containers/provisioner
 */

import { resolve } from 'node:path';
import { mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify as yamlStringify, parse as yamlParse } from 'yaml';

import type {
  ContainerProvisioner,
  AgentDefinition,
} from '../domain/index.js';
import type { Team } from '../domain/index.js';
import { ValidationError, NotFoundError } from '../domain/index.js';
import { validateSlug, RESERVED_SLUGS } from '../domain/index.js';

const execFileAsync = promisify(execFile);

// Agents are placed in their team's workspace

/** Subdirectories created inside every scaffolded workspace. */
const WORKSPACE_DIRS = [
  '.claude/agents',
  '.claude/skills',
  '.credentials',
  'memory',
  'work/tasks',
  'integrations',
  'plugins/sinks',
  'teams',
];

/**
 * Workspace provisioner for team containers.
 *
 * Implements the {@link ContainerProvisioner} interface, handling the full
 * lifecycle of team workspace directories: scaffolding, configuration writing,
 * and teardown.
 *
 * @see {@link Team} for the team configuration shape
 * @see {@link AgentDefinition} for the agent definition shape
 */
export class ContainerProvisionerImpl implements ContainerProvisioner {
  private readonly workspaceRoot: string;

  constructor(workspaceRoot: string = '/app/workspace') {
    this.workspaceRoot = resolve(workspaceRoot);
  }

  async scaffoldWorkspace(parentPath: string, teamSlug: string, agents?: AgentDefinition[], purpose?: string): Promise<string> {
    // Validate slug format (throws generic Error on invalid)
    try {
      validateSlug(teamSlug);
    } catch (err: unknown) {
      throw new ValidationError((err as Error).message);
    }

    // Check reserved slugs
    if (RESERVED_SLUGS.has(teamSlug)) {
      throw new ValidationError(
        `Reserved slug: "${teamSlug}". The following slugs are reserved: ${[...RESERVED_SLUGS].join(', ')}`
      );
    }

    // Validate parentPath is within workspace root
    this.assertWithinWorkspaceRoot(parentPath);

    const fullPath = resolve(parentPath, 'teams', teamSlug);

    // Create all subdirectories
    for (const dir of WORKSPACE_DIRS) {
      await mkdir(resolve(fullPath, dir), { recursive: true });
    }

    // Build agent references for team.yaml (names only; full definitions go in .md files)
    const agentRefs = agents && agents.length > 0
      ? agents.map(a => ({ name: a.name, description: a.description }))
      : [];

    // Write default files
    await writeFile(
      resolve(fullPath, 'team.yaml'),
      yamlStringify({ slug: teamSlug, agents: agentRefs }),
      'utf-8',
    );

    await writeFile(
      resolve(fullPath, '.claude/CLAUDE.md'),
      `# ${teamSlug}\n\n${purpose || 'Team instructions go here.'}\n\n## MCP Tools\n\nUse the openhive-tools MCP server for system operations.\n`,
      'utf-8',
    );

    await writeFile(
      resolve(fullPath, '.claude/settings.json'),
      JSON.stringify({
        permissions: {
          allow: [
            'mcp__openhive-tools',
            'Bash',
            'Read',
            'Write',
            'Edit',
          ],
        },
        enableAllProjectMcpServers: true,
      }, null, 2) + '\n',
      'utf-8',
    );

    // Write each agent definition as an .md file
    if (agents && agents.length > 0) {
      for (const agent of agents) {
        await this.writeAgentDefinition(fullPath, agent);
      }
    }

    return fullPath;
  }

  async writeTeamConfig(workspacePath: string, team: Team): Promise<void> {
    this.assertWithinWorkspaceRoot(workspacePath);
    await this.assertDirectoryExists(workspacePath);

    const filePath = resolve(workspacePath, 'team.yaml');
    await writeFile(filePath, yamlStringify(team), 'utf-8');
  }

  async writeAgentDefinition(workspacePath: string, agent: AgentDefinition): Promise<void> {
    // Agents are placed in their team's workspace
    this.assertWithinWorkspaceRoot(workspacePath);
    await this.assertDirectoryExists(workspacePath);

    const agentsDir = resolve(workspacePath, '.claude/agents');
    await mkdir(agentsDir, { recursive: true });

    // Build YAML frontmatter
    const frontmatter: Record<string, unknown> = {};
    if (agent.aid) {
      frontmatter.aid = agent.aid;
    }
    frontmatter.name = agent.name;
    frontmatter.description = agent.description;
    if (agent.model) {
      frontmatter.model = agent.model;
    }
    if (agent.tools && agent.tools.length > 0) {
      frontmatter.tools = agent.tools;
    }

    const content = `---\n${yamlStringify(frontmatter)}---\n${agent.content}\n`;
    const filePath = resolve(agentsDir, `${agent.name}.md`);
    await writeFile(filePath, content, 'utf-8');
  }

  async addAgentToTeamYaml(
    workspacePath: string,
    agent: {
      aid: string;
      name: string;
      description: string;
      model_tier?: string;
      role?: string;
      tools?: string[];
      provider?: string;
    },
  ): Promise<void> {
    this.assertWithinWorkspaceRoot(workspacePath);
    const teamYamlPath = resolve(workspacePath, 'team.yaml');

    let content: Record<string, unknown> = {};
    try {
      const raw = await readFile(teamYamlPath, 'utf-8');
      content = (yamlParse(raw) as Record<string, unknown>) ?? {};
    } catch {
      // team.yaml doesn't exist yet — will create
    }

    const agents = (content['agents'] as Array<Record<string, unknown>>) ?? [];
    const agentEntry = {
      aid: agent.aid,
      name: agent.name,
      description: agent.description,
      role: agent.role ?? 'member',
      model_tier: agent.model_tier ?? 'sonnet',
      tools: agent.tools ?? [],
      provider: agent.provider ?? 'default',
    };

    // Deduplicate by name: update existing entry or append new
    const existingIdx = agents.findIndex((a) => a['name'] === agent.name);
    if (existingIdx >= 0) {
      agents[existingIdx] = agentEntry;
    } else {
      agents.push(agentEntry);
    }
    content['agents'] = agents;

    await writeFile(teamYamlPath, yamlStringify(content), 'utf-8');
  }

  async writeSettings(workspacePath: string, allowedTools: string[]): Promise<void> {
    this.assertWithinWorkspaceRoot(workspacePath);
    await this.assertDirectoryExists(workspacePath);

    // Claude Code permissions format: tool patterns in allow array
    const mcpTools = allowedTools
      .filter(t => !['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'].includes(t))
      .map(t => `mcp__openhive-tools__${t}`);

    const settings = {
      permissions: {
        allow: [
          'mcp__openhive-tools',  // Allow all MCP tools as fallback
          ...mcpTools,             // Also list individual tools for clarity
          'Bash',
          'Read',
          'Write',
          'Edit',
        ],
      },
      enableAllProjectMcpServers: true,
    };

    const filePath = resolve(workspacePath, '.claude/settings.json');
    await writeFile(filePath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  }

  async deleteWorkspace(workspacePath: string): Promise<void> {
    this.assertWithinWorkspaceRoot(workspacePath);
    await this.assertDirectoryExists(workspacePath);

    await rm(workspacePath, { recursive: true, force: true });
  }

  async archiveWorkspace(workspacePath: string, archivePath: string): Promise<void> {
    this.assertWithinWorkspaceRoot(workspacePath);
    await this.assertDirectoryExists(workspacePath);

    // Ensure archive output directory exists
    const archiveDir = resolve(archivePath, '..');
    await mkdir(archiveDir, { recursive: true });

    // Create tar.gz archive using the system tar command
    const parentDir = resolve(workspacePath, '..');
    const dirName = workspacePath.split('/').pop()!;
    await execFileAsync('tar', ['-czf', archivePath, '-C', parentDir, dirName]);
  }

  /**
   * Validates that a resolved path is within the workspace root.
   * Prevents path traversal attacks.
   */
  private assertWithinWorkspaceRoot(targetPath: string): void {
    const resolved = resolve(targetPath);
    if (!resolved.startsWith(this.workspaceRoot)) {
      throw new ValidationError(
        `Path "${targetPath}" is outside the workspace root "${this.workspaceRoot}"`
      );
    }
  }

  /**
   * Asserts that a directory exists at the given path.
   */
  private async assertDirectoryExists(dirPath: string): Promise<void> {
    try {
      const s = await stat(dirPath);
      if (!s.isDirectory()) {
        throw new NotFoundError(`Not a directory: "${dirPath}"`);
      }
    } catch (err: unknown) {
      if (err instanceof NotFoundError) throw err;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NotFoundError(`Directory not found: "${dirPath}"`);
      }
      throw err;
    }
  }
}
