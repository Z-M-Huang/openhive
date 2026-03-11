/**
 * Container provisioner — workspace scaffolding and team provisioning.
 *
 * Provides the {@link ContainerProvisioner} interface for creating, configuring,
 * and tearing down team workspaces. Each team workspace is a self-contained
 * directory tree that gets bind-mounted into the team's Docker container at
 * `/app/workspace`.
 *
 * // INV-01: Team lead always in parent container
 * The provisioner scaffolds the workspace structure but does NOT place the team
 * lead's agent definition inside the child workspace. The team lead always runs
 * in the parent container — its agent definition lives in the parent's workspace.
 * The child workspace only contains agent definitions for non-lead team members.
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

import type {
  ContainerProvisioner,
  AgentDefinition,
} from '../domain/index.js';
import type { Team } from '../domain/index.js';

// INV-01: Team lead always in parent container

/**
 * Workspace provisioner for team containers.
 *
 * Implements the {@link ContainerProvisioner} interface, handling the full
 * lifecycle of team workspace directories: scaffolding, configuration writing,
 * and teardown.
 *
 * **Invariants enforced by this class:**
 * - INV-01: Team lead always in parent container — the lead's agent definition
 *   is NOT written to the child workspace. Only non-lead agent definitions are
 *   placed in the child workspace's `.claude/agents/` directory.
 * - Workspace paths are validated against the workspace root to prevent
 *   path traversal attacks.
 * - Team slugs are validated before directory creation (no reserved slugs,
 *   valid format).
 * - Archive operations create compressed backups before workspace deletion.
 *
 * @see {@link Team} for the team configuration shape
 * @see {@link AgentDefinition} for the agent definition shape
 */
export class ContainerProvisionerImpl implements ContainerProvisioner {
  /**
   * Scaffolds a new team workspace directory tree.
   *
   * Creates the complete workspace directory structure under
   * `<parentPath>/teams/<teamSlug>/` with all required subdirectories:
   *
   * - `team.yaml` — empty team config placeholder
   * - `.claude/CLAUDE.md` — team-specific Claude instructions
   * - `.claude/settings.json` — default allowed tools (`{"allowedTools":[]}`)
   * - `.claude/agents/` — agent definition files directory
   * - `.claude/skills/` — skill definition files directory
   * - `memory/` — agent memory storage
   * - `integrations/` — integration configurations
   * - `plugins/sinks/` — log sink plugins
   * - `teams/` — child team workspaces (enables recursive nesting)
   * - `work/tasks/` — task-scoped working directories
   *
   * // INV-01: Team lead always in parent container
   * The scaffolded workspace does NOT include the team lead's agent definition.
   * The lead agent runs in the parent container and its definition lives in the
   * parent workspace. Only non-lead team members have definitions in this workspace.
   *
   * @param _parentPath - Absolute path to the parent workspace (e.g., `.run/workspace`)
   * @param _teamSlug - Team slug for the new workspace (e.g., `weather-team`)
   * @returns Absolute path to the newly created workspace directory
   * @throws {ValidationError} If the team slug is invalid or reserved
   * @throws {ValidationError} If the parent path is outside the workspace root
   * @throws {Error} If the workspace directory already exists
   */
  async scaffoldWorkspace(_parentPath: string, _teamSlug: string): Promise<string> {
    // INV-01: Team lead always in parent container
    throw new Error('Not implemented');
  }

  /**
   * Writes the team configuration file (`team.yaml`) to the workspace.
   *
   * Serializes the {@link Team} configuration to YAML format and writes it
   * to `<workspacePath>/team.yaml`. This includes the team's agent list,
   * MCP server configurations, and other team-level settings.
   *
   * // INV-01: Team lead always in parent container
   * The `leader_aid` in the team config references an agent that runs in the
   * parent container. The team.yaml records this AID for reference but the
   * lead's agent definition file is NOT in this workspace.
   *
   * @param _workspacePath - Absolute path to the team workspace
   * @param _team - Team configuration to write
   * @throws {ValidationError} If the workspace path is outside the workspace root
   * @throws {NotFoundError} If the workspace directory does not exist
   */
  async writeTeamConfig(_workspacePath: string, _team: Team): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Writes an agent definition file to the workspace.
   *
   * Creates or updates the agent definition file at
   * `<workspacePath>/.claude/agents/<name>.md` with YAML frontmatter
   * (`name`, `description`, optional `model`, `tools`) followed by the
   * agent's free-form content/instructions.
   *
   * // INV-01: Team lead always in parent container
   * This method should only be called for non-lead team members whose agent
   * definitions belong in this workspace. The team lead's definition lives
   * in the parent workspace, not the child team's workspace.
   *
   * @param _workspacePath - Absolute path to the team workspace
   * @param _agent - Agent definition to write (name, description, content, etc.)
   * @throws {ValidationError} If the workspace path is outside the workspace root
   * @throws {NotFoundError} If the workspace directory does not exist
   */
  async writeAgentDefinition(_workspacePath: string, _agent: AgentDefinition): Promise<void> {
    // INV-01: Team lead always in parent container
    throw new Error('Not implemented');
  }

  /**
   * Writes the allowed tools settings file to the workspace.
   *
   * Creates or updates `<workspacePath>/.claude/settings.json` with the
   * specified list of allowed tools. The settings file follows the Claude
   * workspace settings format: `{"allowedTools": [...]}`.
   *
   * @param _workspacePath - Absolute path to the team workspace
   * @param _allowedTools - Array of tool name patterns to allow
   * @throws {ValidationError} If the workspace path is outside the workspace root
   * @throws {NotFoundError} If the workspace directory does not exist
   */
  async writeSettings(_workspacePath: string, _allowedTools: string[]): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Deletes a team workspace directory and all its contents.
   *
   * Recursively removes the workspace directory at the specified path.
   * The path MUST be within the workspace root — attempting to delete
   * outside the workspace tree is rejected.
   *
   * This is a destructive operation. Consider calling {@link archiveWorkspace}
   * first to create a backup.
   *
   * @param _workspacePath - Absolute path to the workspace to delete
   * @throws {ValidationError} If the path is outside the workspace root
   * @throws {NotFoundError} If the workspace directory does not exist
   */
  async deleteWorkspace(_workspacePath: string): Promise<void> {
    throw new Error('Not implemented');
  }

  /**
   * Archives a team workspace to a compressed backup before deletion.
   *
   * Creates a compressed archive (tar.gz) of the workspace directory at the
   * specified archive path. This preserves the workspace contents for audit
   * and recovery purposes before the workspace is deleted.
   *
   * The archive includes all workspace files: team.yaml, agent definitions,
   * skill definitions, memory, work directories, and any child team workspaces.
   *
   * @param _workspacePath - Absolute path to the workspace to archive
   * @param _archivePath - Absolute path for the output archive file (.tar.gz)
   * @throws {ValidationError} If either path is outside the workspace root
   * @throws {NotFoundError} If the workspace directory does not exist
   */
  async archiveWorkspace(_workspacePath: string, _archivePath: string): Promise<void> {
    throw new Error('Not implemented');
  }
}
