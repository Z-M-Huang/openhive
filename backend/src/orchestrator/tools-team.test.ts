/**
 * Tests for team SDK tool handlers (tools-team.ts)
 *
 * Covers:
 *   1. create_agent adds agent to team config
 *   2. create_agent adds agent to master config when team_slug is "master"
 *   3. create_agent validates required fields
 *   4. create_agent validates model_tier
 *   5. create_agent generates a valid AID
 *   6. create_team creates directory and config
 *   7. create_team validates leader exists in OrgChart
 *   8. create_team validates slug
 *   9. create_team generates valid TID
 *   10. create_team rejects duplicate slug
 *   11. create_team publishes team_created event
 *   12. delete_team removes config directory
 *   13. delete_team validates team exists
 *   14. delete_team publishes team_deleted event
 *   15. get_team returns team configuration
 *   16. get_team validates slug
 *   17. list_teams returns all teams from OrgChart
 *   18. update_team updates env_vars
 *   19. update_team updates container_config
 *   20. update_team rejects unknown field
 *   21. get_member_status by agent_aid
 *   22. get_member_status by team_slug
 *   23. get_member_status requires at least one arg
 *   24. delete_agent removes agent from team config
 *   25. delete_agent removes agent from master config
 *   26. delete_agent rejects deletion if agent leads a team
 *   27. registerTeamTools registers all expected tool names
 *   28. slugifyName converts display names correctly
 *   29. create_team scaffolds workspace directory structure after saving config
 *   30. create_team proceeds with team creation even when scaffoldTeamWorkspace fails
 *   31. create_agent writes .claude/agents/<name>.md with YAML frontmatter to workspace
 *   32. create_agent stores description in workspace frontmatter
 *   33. delete_team cancels in-progress tasks before removing workspace
 *   34. delete_team removes workspace via validateWorkspacePath + rm
 *   35. delete_team tolerates ENOENT when workspace already removed
 *   36. delete_team rethrows unexpected filesystem errors
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerTeamTools, slugifyName, type TeamToolsDeps } from './tools-team.js';
import { ToolHandler } from './toolhandler.js';
import { ValidationError, ConflictError, NotFoundError } from '../domain/errors.js';
import type { ConfigLoader, OrgChart, EventBus, KeyManager, TaskStore } from '../domain/interfaces.js';
import type { MasterConfig, Team, Agent, Task, JsonValue } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Module mock — scaffoldTeamWorkspace
// ---------------------------------------------------------------------------
// vi.mock is hoisted by Vitest so the mock is in place before any imports run.
// We replace scaffoldTeamWorkspace with a spy that resolves immediately,
// preventing real filesystem operations during tests.

vi.mock('./orchestrator.js', () => ({
  scaffoldTeamWorkspace: vi.fn().mockResolvedValue(undefined),
  // Return a safe resolved path: /run/openhive/teams/<slug>
  validateWorkspacePath: vi.fn().mockImplementation((_runDir: string, slug: string) => {
    return `/run/openhive/teams/${slug}`;
  }),
}));

// ---------------------------------------------------------------------------
// Module mock — node:fs/promises
// ---------------------------------------------------------------------------
// Prevent real filesystem operations from create_agent's workspace file writes.
// We spy on mkdir and writeFile to verify they are called correctly.

vi.mock('node:fs/promises', () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
}));

import { scaffoldTeamWorkspace, validateWorkspacePath } from './orchestrator.js';
import { mkdir as fsMkdir, writeFile as fsWriteFile, rm as fsRm, unlink as fsUnlink } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Helpers — factory functions for mock objects
// ---------------------------------------------------------------------------

function makeMasterConfig(agents: Agent[] = []): MasterConfig {
  return {
    system: {
      listen_address: ':8080',
      data_dir: '/data',
      workspace_root: '/teams',
      log_level: 'info',
      log_archive: { enabled: false, max_entries: 1000, keep_copies: 3, archive_dir: '' },
      max_message_length: 4096,
      default_idle_timeout: '30m',
      event_bus_workers: 4,
      portal_ws_max_connections: 100,
      message_archive: { enabled: false, max_entries: 1000, keep_copies: 3, archive_dir: '' },
    },
    assistant: {
      name: 'Hive',
      aid: 'aid-main-001',
      provider: 'default',
      model_tier: 'sonnet',
      max_turns: 50,
      timeout_minutes: 30,
    },
    agents,
    channels: {
      discord: { enabled: false },
      whatsapp: { enabled: false },
    },
  };
}

function makeTeam(slug: string, leaderAID: string, agents: Agent[] = []): Team {
  return {
    tid: `tid-${slug.slice(0, 8)}-test0001`,
    slug,
    leader_aid: leaderAID,
    agents,
  };
}

function makeAgent(aid: string, name: string): Agent {
  return { aid, name };
}

function makeMockConfigLoader(
  masterCfg: MasterConfig,
  teams: Record<string, Team> = {},
): ConfigLoader {
  // Make a mutable copy of teams so tests can observe mutations
  const teamStore = { ...teams };

  return {
    loadMaster: vi.fn().mockImplementation(() => Promise.resolve(masterCfg)),
    saveMaster: vi.fn().mockImplementation((cfg: MasterConfig) => {
      // Copy fields from cfg into masterCfg to simulate mutation
      Object.assign(masterCfg, cfg);
      return Promise.resolve();
    }),
    getMaster: vi.fn().mockReturnValue(masterCfg),
    loadProviders: vi.fn().mockResolvedValue({}),
    saveProviders: vi.fn().mockResolvedValue(undefined),
    loadTeam: vi.fn().mockImplementation((slug: string) => {
      const t = teamStore[slug];
      if (t === undefined) {
        return Promise.reject(new NotFoundError('team', slug));
      }
      return Promise.resolve(t);
    }),
    saveTeam: vi.fn().mockImplementation((slug: string, team: Team) => {
      teamStore[slug] = team;
      return Promise.resolve();
    }),
    createTeamDir: vi.fn().mockResolvedValue(undefined),
    deleteTeamDir: vi.fn().mockResolvedValue(undefined),
    listTeams: vi.fn().mockImplementation(() => Promise.resolve(Object.keys(teamStore))),
    watchMaster: vi.fn().mockResolvedValue(undefined),
    watchProviders: vi.fn().mockResolvedValue(undefined),
    watchTeam: vi.fn().mockResolvedValue(undefined),
    stopWatching: vi.fn(),
  };
}

function makeMockOrgChart(
  agentsByAID: Record<string, Agent> = {},
  teamsBySlug: Record<string, Team> = {},
  leadTeams: Record<string, string[]> = {},
): OrgChart {
  return {
    getOrgChart: vi.fn().mockReturnValue(teamsBySlug),
    getAgentByAID: vi.fn().mockImplementation((aid: string) => {
      const agent = agentsByAID[aid];
      if (agent === undefined) throw new NotFoundError('agent', aid);
      return agent;
    }),
    getTeamBySlug: vi.fn().mockImplementation((slug: string) => {
      const team = teamsBySlug[slug];
      if (team === undefined) throw new NotFoundError('team', slug);
      return team;
    }),
    getTeamForAgent: vi.fn().mockImplementation((aid: string) => {
      for (const team of Object.values(teamsBySlug)) {
        for (const a of team.agents ?? []) {
          if (a.aid === aid) return team;
        }
      }
      throw new NotFoundError('team', `for agent ${aid}`);
    }),
    getLeadTeams: vi.fn().mockImplementation((aid: string) => leadTeams[aid] ?? []),
    getSubordinates: vi.fn().mockReturnValue([]),
    getSupervisor: vi.fn().mockReturnValue(null),
    rebuildFromConfig: vi.fn(),
  };
}

function makeMockEventBus(): EventBus {
  return {
    publish: vi.fn(),
    subscribe: vi.fn().mockReturnValue('sub-id'),
    filteredSubscribe: vi.fn().mockReturnValue('sub-id'),
    unsubscribe: vi.fn(),
    close: vi.fn(),
  };
}

function makeMockKeyManager(): KeyManager {
  return {
    encrypt: vi.fn(),
    decrypt: vi.fn(),
    isLocked: vi.fn().mockReturnValue(false),
    unlock: vi.fn(),
    lock: vi.fn(),
  };
}

function makeMockTaskStore(tasks: Task[] = []): TaskStore {
  const taskList = [...tasks];
  return {
    create: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockImplementation((id: string) => {
      const t = taskList.find((x) => x.id === id);
      if (t === undefined) throw new NotFoundError('task', id);
      return Promise.resolve(t);
    }),
    update: vi.fn().mockImplementation((task: Task) => {
      const idx = taskList.findIndex((x) => x.id === task.id);
      if (idx !== -1) taskList[idx] = task;
      return Promise.resolve();
    }),
    delete: vi.fn().mockResolvedValue(undefined),
    listByTeam: vi.fn().mockResolvedValue(taskList),
    listByStatus: vi.fn().mockResolvedValue([]),
    getSubtree: vi.fn().mockResolvedValue([]),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let masterCfg: MasterConfig;
let existingAgent: Agent;
let existingTeam: Team;
let configLoader: ConfigLoader;
let orgChart: OrgChart;
let eventBus: EventBus;
let taskStore: TaskStore;
let deps: TeamToolsDeps;
let handler: ToolHandler;

beforeEach(() => {
  existingAgent = makeAgent('aid-lead-00000001', 'Lead Agent');
  existingTeam = makeTeam('my-team', 'aid-lead-00000001', [existingAgent]);
  masterCfg = makeMasterConfig([existingAgent]);

  configLoader = makeMockConfigLoader(masterCfg, { 'my-team': existingTeam });
  orgChart = makeMockOrgChart(
    { 'aid-lead-00000001': existingAgent },
    { 'my-team': existingTeam },
  );
  eventBus = makeMockEventBus();
  taskStore = makeMockTaskStore();
  deps = {
    configLoader,
    orgChart,
    eventBus,
    keyManager: makeMockKeyManager(),
    taskStore,
    runDir: '/run/openhive',
    containerManager: null,
    wsHub: null,
    logger: makeLogger(),
  };
  handler = new ToolHandler(makeLogger());
  registerTeamTools(handler, deps);

  // Reset filesystem mocks between tests
  (fsMkdir as ReturnType<typeof vi.fn>).mockClear();
  (fsWriteFile as ReturnType<typeof vi.fn>).mockClear();
  (fsRm as ReturnType<typeof vi.fn>).mockClear();
  (fsUnlink as ReturnType<typeof vi.fn>).mockClear();
  (validateWorkspacePath as ReturnType<typeof vi.fn>).mockClear();
});

// ---------------------------------------------------------------------------
// registerTeamTools
// ---------------------------------------------------------------------------

describe('registerTeamTools', () => {
  it('registers all expected tool names', () => {
    const tools = handler.registeredTools();
    expect(tools).toContain('create_agent');
    expect(tools).toContain('create_team');
    expect(tools).toContain('delete_team');
    expect(tools).toContain('delete_agent');
    expect(tools).toContain('list_teams');
    expect(tools).toContain('get_team');
    expect(tools).toContain('update_team');
    expect(tools).toContain('get_member_status');
    expect(tools).toContain('create_skill');
    expect(tools).toContain('load_skill');
  });
});

// ---------------------------------------------------------------------------
// slugifyName
// ---------------------------------------------------------------------------

describe('slugifyName', () => {
  it('lowercases letters', () => {
    expect(slugifyName('Hello')).toBe('hello');
  });

  it('keeps digits', () => {
    expect(slugifyName('Agent42')).toBe('agent42');
  });

  it('converts spaces to hyphens', () => {
    expect(slugifyName('Lead Agent')).toBe('lead-agent');
  });

  it('collapses multiple spaces/hyphens to single hyphen', () => {
    expect(slugifyName('Lead  --  Agent')).toBe('lead-agent');
  });

  it('trims trailing hyphens', () => {
    expect(slugifyName('Lead-')).toBe('lead');
  });

  it('returns "agent" for empty/symbol-only names', () => {
    expect(slugifyName('')).toBe('agent');
    expect(slugifyName('!!!')).toBe('agent');
  });

  it('caps at 16 characters', () => {
    const long = 'averylongnamethatexceedssixteen';
    const result = slugifyName(long);
    expect(result.length).toBeLessThanOrEqual(16);
  });
});

// ---------------------------------------------------------------------------
// create_agent
// ---------------------------------------------------------------------------

describe('create_agent', () => {
  it('adds agent to a team config and returns a valid AID', async () => {
    const result = await handler.handleToolCall('c1', 'create_agent', {
      name: 'Worker',
      description: 'worker.role.md',
      team_slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('created');
    const aid = result['aid'] as string;
    expect(aid).toMatch(/^aid-worker-[a-z0-9]{8}$/);
    expect(configLoader.saveTeam).toHaveBeenCalled();
  });

  it('adds agent to master config when team_slug is "master"', async () => {
    const result = await handler.handleToolCall('c2', 'create_agent', {
      name: 'Assistant',
      description: 'assistant.role.md',
      team_slug: 'master',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('created');
    const aid = result['aid'] as string;
    expect(aid).toMatch(/^aid-assistant-[a-z0-9]{8}$/);
    expect(configLoader.saveMaster).toHaveBeenCalled();
  });

  it('throws ValidationError when name is missing', async () => {
    await expect(
      handler.handleToolCall('c3', 'create_agent', {
        description: 'x.role.md',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('c4', 'create_agent', {
        description: 'x.role.md',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow('name is required');
  });

  it('throws ValidationError when description is missing', async () => {
    await expect(
      handler.handleToolCall('c5', 'create_agent', {
        name: 'Worker',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when team_slug is missing', async () => {
    await expect(
      handler.handleToolCall('c6', 'create_agent', {
        name: 'Worker',
        description: 'x.role.md',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('c7', 'create_agent', {
        name: 'Worker',
        description: 'x.role.md',
      }),
    ).rejects.toThrow('team_slug is required');
  });

  it('throws ValidationError for invalid model_tier', async () => {
    await expect(
      handler.handleToolCall('c8', 'create_agent', {
        name: 'Worker',
        description: 'x.role.md',
        team_slug: 'my-team',
        model_tier: 'ultra',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('c9', 'create_agent', {
        name: 'Worker',
        description: 'x.role.md',
        team_slug: 'my-team',
        model_tier: 'ultra',
      }),
    ).rejects.toThrow('invalid model_tier: ultra');
  });

  it('accepts valid model_tier values', async () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      const result = await handler.handleToolCall('c10', 'create_agent', {
        name: `${tier} agent`,
        description: 'x.role.md',
        team_slug: 'my-team',
        model_tier: tier,
      }) as Record<string, JsonValue>;
      expect(result['status']).toBe('created');
    }
  });

  it('generates a unique AID with aid- prefix format', async () => {
    const r1 = await handler.handleToolCall('c11', 'create_agent', {
      name: 'Worker',
      description: 'x.role.md',
      team_slug: 'master',
    }) as Record<string, JsonValue>;
    const r2 = await handler.handleToolCall('c12', 'create_agent', {
      name: 'Worker',
      description: 'x.role.md',
      team_slug: 'master',
    }) as Record<string, JsonValue>;

    // Same name, different AIDs (unique shortID suffix)
    expect(r1['aid']).not.toBe(r2['aid']);
    expect(r1['aid'] as string).toMatch(/^aid-worker-[a-z0-9]{8}$/);
  });

  it('rebuilds orgchart after creating an agent', async () => {
    await handler.handleToolCall('c13', 'create_agent', {
      name: 'Builder',
      description: 'builder.role.md',
      team_slug: 'master',
    });
    expect(orgChart.rebuildFromConfig).toHaveBeenCalled();
  });

  it('writes .claude/agents/<name>.md with YAML frontmatter to workspace', async () => {
    const mockMkdir = fsMkdir as ReturnType<typeof vi.fn>;
    const mockWriteFile = fsWriteFile as ReturnType<typeof vi.fn>;

    await handler.handleToolCall('c14', 'create_agent', {
      name: 'Worker',
      description: 'worker.role.md',
      team_slug: 'my-team',
      model_tier: 'sonnet',
    });

    // mkdir should be called with the .claude/agents/ directory
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('/run/openhive/teams/my-team/.claude/agents'),
      { recursive: true },
    );

    // writeFile should be called with a .md path containing YAML frontmatter
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writeArgs = mockWriteFile.mock.calls[0] as [string, string, { mode: number }];
    expect(writeArgs[0]).toMatch(/worker\.md$/);
    const content = writeArgs[1];
    expect(content).toContain('---');
    expect(content).toContain('name: Worker');
    expect(content).toContain('description: worker.role.md');
    expect(content).toContain('model: sonnet');
    expect(writeArgs[2]).toEqual({ mode: 0o644 });
  });

  it('writes workspace file using "main" slug for team_slug "master"', async () => {
    const mockMkdir = fsMkdir as ReturnType<typeof vi.fn>;

    await handler.handleToolCall('c15', 'create_agent', {
      name: 'Assistant',
      description: 'assistant.role.md',
      team_slug: 'master',
    });

    // The workspace directory should use 'main' not 'master'
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('/run/openhive/teams/main/.claude/agents'),
      { recursive: true },
    );
  });

  it('stores description in workspace frontmatter when writing .claude/agents/ file', async () => {
    const mockWriteFile = fsWriteFile as ReturnType<typeof vi.fn>;
    mockWriteFile.mockClear();

    await handler.handleToolCall('c16', 'create_agent', {
      name: 'Compat Worker',
      description: 'compat.role.md',
      team_slug: 'my-team',
    });

    // Workspace file should contain the description in frontmatter
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writeArgs = mockWriteFile.mock.calls[0] as [string, string, { mode: number }];
    const content = writeArgs[1];
    expect(content).toContain('description: compat.role.md');

    // Agent in config should NOT have role_file (it was removed)
    const saveCall = (configLoader.saveTeam as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'my-team',
    );
    expect(saveCall).toBeDefined();
    const savedTeam = saveCall![1] as Team;
    const savedAgent = savedTeam.agents?.find((a) => a.name === 'Compat Worker');
    expect(savedAgent).toBeDefined();
    expect((savedAgent as Record<string, unknown>)['role_file']).toBeUndefined();
  });

  it('proceeds with agent creation even when workspace file write fails', async () => {
    const mockMkdir = fsMkdir as ReturnType<typeof vi.fn>;
    mockMkdir.mockRejectedValueOnce(new Error('disk full'));

    const result = await handler.handleToolCall('c17', 'create_agent', {
      name: 'Resilient Worker',
      description: 'resilient.role.md',
      team_slug: 'my-team',
    }) as Record<string, JsonValue>;

    // Agent creation succeeds despite workspace write failure
    expect(result['status']).toBe('created');
    expect(result['aid']).toBeDefined();
    expect(configLoader.saveTeam).toHaveBeenCalled();
    // Warning should be logged
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'failed to write .claude/agents/ file',
      expect.objectContaining({ error: expect.stringContaining('disk full') as unknown }),
    );
  });
});

// ---------------------------------------------------------------------------
// create_team
// ---------------------------------------------------------------------------

describe('create_team', () => {
  it('creates a team directory and saves config', async () => {
    const result = await handler.handleToolCall('t1', 'create_team', {
      slug: 'dev-team',
      leader_aid: 'aid-lead-00000001',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('created');
    expect(result['slug']).toBe('dev-team');
    expect(configLoader.createTeamDir).toHaveBeenCalledWith('dev-team');
    expect(configLoader.saveTeam).toHaveBeenCalled();
  });

  it('generates a valid TID with tid- prefix format', async () => {
    const result = await handler.handleToolCall('t2', 'create_team', {
      slug: 'dev-team',
      leader_aid: 'aid-lead-00000001',
    }) as Record<string, JsonValue>;

    const tid = result['tid'] as string;
    // tid-{slug[:8]}-{8-char uuid hex}
    expect(tid).toMatch(/^tid-dev-team-[a-z0-9]{8}$/);
  });

  it('generates TID using first 8 chars of slug', async () => {
    const result = await handler.handleToolCall('t3', 'create_team', {
      slug: 'longteamslugname',
      leader_aid: 'aid-lead-00000001',
    }) as Record<string, JsonValue>;

    const tid = result['tid'] as string;
    // 'longteamslugname'.slice(0, 8) === 'longteam'
    expect(tid.startsWith('tid-longteam-')).toBe(true);
  });

  it('validates leader_aid exists in OrgChart', async () => {
    await expect(
      handler.handleToolCall('t4', 'create_team', {
        slug: 'dev-team',
        leader_aid: 'aid-ghost-00000000',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('t5', 'create_team', {
        slug: 'dev-team',
        leader_aid: 'aid-ghost-00000000',
      }),
    ).rejects.toThrow('agent aid-ghost-00000000 does not exist');
  });

  it('throws ValidationError for invalid slug', async () => {
    await expect(
      handler.handleToolCall('t6', 'create_team', {
        slug: 'Invalid Slug!',
        leader_aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when leader_aid is missing', async () => {
    await expect(
      handler.handleToolCall('t7', 'create_team', {
        slug: 'dev-team',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('t8', 'create_team', {
        slug: 'dev-team',
      }),
    ).rejects.toThrow('leader_aid is required');
  });

  it('throws ConflictError for duplicate slug', async () => {
    await expect(
      handler.handleToolCall('t9', 'create_team', {
        slug: 'my-team', // already in configLoader
        leader_aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow(ConflictError);
    await expect(
      handler.handleToolCall('t10', 'create_team', {
        slug: 'my-team',
        leader_aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow('team my-team already exists');
  });

  it('throws ValidationError for reserved slug "main"', async () => {
    await expect(
      handler.handleToolCall('t15', 'create_team', {
        slug: 'main',
        leader_aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('t16', 'create_team', {
        slug: 'main',
        leader_aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow('slug "main" is reserved');
  });

  it('throws ValidationError for reserved slug "system"', async () => {
    await expect(
      handler.handleToolCall('t17', 'create_team', {
        slug: 'system',
        leader_aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('t18', 'create_team', {
        slug: 'system',
        leader_aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow('slug "system" is reserved');
  });

  it('publishes a team_created event', async () => {
    await handler.handleToolCall('t11', 'create_team', {
      slug: 'analytics',
      leader_aid: 'aid-lead-00000001',
    });
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'team_created' }),
    );
    const call = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.payload.kind).toBe('team_created');
    expect(typeof call.payload.team_id).toBe('string');
    expect(call.payload.team_id).toMatch(/^tid-analytic-[a-z0-9]{8}$/);
  });

  it('does not publish event when eventBus is null', async () => {
    const localDeps: TeamToolsDeps = { ...deps, eventBus: null };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    // Should not throw
    await expect(
      localHandler.handleToolCall('t12', 'create_team', {
        slug: 'no-events',
        leader_aid: 'aid-lead-00000001',
      }),
    ).resolves.toBeDefined();
  });

  it('rebuilds orgchart after creating a team', async () => {
    await handler.handleToolCall('t13', 'create_team', {
      slug: 'rebuild-test',
      leader_aid: 'aid-lead-00000001',
    });
    expect(orgChart.rebuildFromConfig).toHaveBeenCalled();
  });

  it('stores parent_slug when provided', async () => {
    await handler.handleToolCall('t14', 'create_team', {
      slug: 'child-team',
      leader_aid: 'aid-lead-00000001',
      parent_slug: 'my-team',
    });
    const savedTeam = (configLoader.saveTeam as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'child-team',
    )?.[1] as Team | undefined;
    expect(savedTeam?.parent_slug).toBe('my-team');
  });

  it('scaffolds workspace directory structure after saving config', async () => {
    const mockScaffold = scaffoldTeamWorkspace as ReturnType<typeof vi.fn>;
    mockScaffold.mockClear();

    await handler.handleToolCall('t19', 'create_team', {
      slug: 'scaffold-test',
      leader_aid: 'aid-lead-00000001',
    });

    expect(mockScaffold).toHaveBeenCalledOnce();
    expect(mockScaffold).toHaveBeenCalledWith('/run/openhive', 'scaffold-test', {
      skillsSourceDir: undefined,
    });
  });

  it('proceeds with team creation even when scaffoldTeamWorkspace fails', async () => {
    const mockScaffold = scaffoldTeamWorkspace as ReturnType<typeof vi.fn>;
    mockScaffold.mockClear();
    mockScaffold.mockRejectedValueOnce(new Error('disk full'));

    const result = await handler.handleToolCall('t20', 'create_team', {
      slug: 'scaffold-fail-test',
      leader_aid: 'aid-lead-00000001',
    }) as Record<string, JsonValue>;

    // Team is still created successfully despite scaffold failure.
    expect(result['status']).toBe('created');
    expect(result['slug']).toBe('scaffold-fail-test');
    expect(configLoader.saveTeam).toHaveBeenCalled();
    // Scaffold was attempted.
    expect(mockScaffold).toHaveBeenCalledWith('/run/openhive', 'scaffold-fail-test', {
      skillsSourceDir: undefined,
    });
    // Warning was logged for the failure.
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'failed to scaffold workspace for new team',
      expect.objectContaining({ slug: 'scaffold-fail-test', error: 'disk full' }),
    );
  });
});

// ---------------------------------------------------------------------------
// delete_team
// ---------------------------------------------------------------------------

describe('delete_team', () => {
  it('removes the team config directory', async () => {
    const result = await handler.handleToolCall('d1', 'delete_team', {
      slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
    expect(result['slug']).toBe('my-team');
    expect(configLoader.deleteTeamDir).toHaveBeenCalledWith('my-team');
  });

  it('throws NotFoundError for unknown team', async () => {
    await expect(
      handler.handleToolCall('d2', 'delete_team', { slug: 'ghost-team' }),
    ).rejects.toThrow(NotFoundError);
    await expect(
      handler.handleToolCall('d3', 'delete_team', { slug: 'ghost-team' }),
    ).rejects.toThrow('team not found: ghost-team');
  });

  it('throws ValidationError for invalid slug', async () => {
    await expect(
      handler.handleToolCall('d4', 'delete_team', { slug: '' }),
    ).rejects.toThrow(ValidationError);
  });

  it('publishes a team_deleted event', async () => {
    await handler.handleToolCall('d5', 'delete_team', { slug: 'my-team' });
    expect(eventBus.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'team_deleted' }),
    );
    const call = (eventBus.publish as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.payload.kind).toBe('team_deleted');
    expect(call.payload.team_id).toBe('tid-my-team-test0001');
  });

  it('rebuilds orgchart after deletion', async () => {
    await handler.handleToolCall('d6', 'delete_team', { slug: 'my-team' });
    expect(orgChart.rebuildFromConfig).toHaveBeenCalled();
  });

  it('cancels pending and running tasks before removing workspace', async () => {
    const now = new Date();
    const pendingTask: Task = {
      id: 'task-001',
      team_slug: 'my-team',
      status: 'pending',
      prompt: 'Do work',
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    const runningTask: Task = {
      id: 'task-002',
      team_slug: 'my-team',
      status: 'running',
      prompt: 'More work',
      created_at: now,
      updated_at: now,
      completed_at: null,
    };
    const completedTask: Task = {
      id: 'task-003',
      team_slug: 'my-team',
      status: 'completed',
      prompt: 'Done work',
      created_at: now,
      updated_at: now,
      completed_at: now,
    };

    const localTaskStore = makeMockTaskStore([pendingTask, runningTask, completedTask]);
    const localDeps: TeamToolsDeps = { ...deps, taskStore: localTaskStore };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    await localHandler.handleToolCall('d7', 'delete_team', { slug: 'my-team' });

    // update should be called for pending and running, not for completed
    const updateCalls = (localTaskStore.update as ReturnType<typeof vi.fn>).mock.calls as [Task][];
    const updatedIds = updateCalls.map((c) => c[0].id);
    expect(updatedIds).toContain('task-001');
    expect(updatedIds).toContain('task-002');
    expect(updatedIds).not.toContain('task-003');

    // Failed tasks should have status 'failed' and error 'team deleted'
    const t1Update = updateCalls.find((c) => c[0].id === 'task-001')?.[0];
    expect(t1Update?.status).toBe('failed');
    expect(t1Update?.error).toBe('team deleted');
  });

  it('calls validateWorkspacePath and rm to remove workspace before config dir', async () => {
    await handler.handleToolCall('d8', 'delete_team', { slug: 'my-team' });

    expect(validateWorkspacePath).toHaveBeenCalledWith('/run/openhive', 'my-team');
    expect(fsRm).toHaveBeenCalledWith(
      '/run/openhive/teams/my-team',
      { recursive: true },
    );
    // Config dir removal happens after workspace removal
    expect(configLoader.deleteTeamDir).toHaveBeenCalledWith('my-team');
  });

  it('tolerates ENOENT when workspace directory already removed', async () => {
    const enoentError = Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
    (fsRm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(enoentError);

    // Should not throw — ENOENT is tolerated
    const result = await handler.handleToolCall('d9', 'delete_team', {
      slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
    // Warning should be logged
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'workspace already removed',
      expect.objectContaining({ slug: 'my-team' }),
    );
  });

  it('rethrows unexpected filesystem errors from rm', async () => {
    const permError = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    (fsRm as ReturnType<typeof vi.fn>).mockRejectedValueOnce(permError);

    await expect(
      handler.handleToolCall('d10', 'delete_team', { slug: 'my-team' }),
    ).rejects.toThrow('EACCES');
  });
});

// ---------------------------------------------------------------------------
// get_team
// ---------------------------------------------------------------------------

describe('get_team', () => {
  it('returns team configuration for a known slug', async () => {
    const result = await handler.handleToolCall('g1', 'get_team', {
      slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['slug']).toBe('my-team');
    expect(result['leader_aid']).toBe('aid-lead-00000001');
    expect(configLoader.loadTeam).toHaveBeenCalledWith('my-team');
  });

  it('throws for invalid slug', async () => {
    await expect(
      handler.handleToolCall('g2', 'get_team', { slug: '' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws when team does not exist', async () => {
    await expect(
      handler.handleToolCall('g3', 'get_team', { slug: 'no-such-team' }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// list_teams
// ---------------------------------------------------------------------------

describe('list_teams', () => {
  it('returns all teams from OrgChart', async () => {
    const result = await handler.handleToolCall('l1', 'list_teams', {});
    expect(result).toEqual({ 'my-team': existingTeam });
    expect(orgChart.getOrgChart).toHaveBeenCalled();
  });

  it('returns empty object when no teams exist', async () => {
    const localOrgChart = makeMockOrgChart({}, {});
    const localDeps: TeamToolsDeps = { ...deps, orgChart: localOrgChart };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('l2', 'list_teams', {});
    expect(result).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// update_team
// ---------------------------------------------------------------------------

describe('update_team', () => {
  it('updates env_vars and saves', async () => {
    const result = await handler.handleToolCall('u1', 'update_team', {
      slug: 'my-team',
      field: 'env_vars',
      value: { NODE_ENV: 'production', DEBUG: 'false' },
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('updated');
    expect(result['slug']).toBe('my-team');
    expect(result['field']).toBe('env_vars');
    expect(configLoader.saveTeam).toHaveBeenCalled();

    const savedTeam = (configLoader.saveTeam as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'my-team',
    )?.[1] as Team | undefined;
    expect(savedTeam?.env_vars).toEqual({ NODE_ENV: 'production', DEBUG: 'false' });
  });

  it('throws ValidationError when env_vars value is not a string map', async () => {
    await expect(
      handler.handleToolCall('u2', 'update_team', {
        slug: 'my-team',
        field: 'env_vars',
        value: { KEY: 42 },
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('u3', 'update_team', {
        slug: 'my-team',
        field: 'env_vars',
        value: { KEY: 42 },
      }),
    ).rejects.toThrow('env_vars must be a string map');
  });

  it('updates container_config and saves', async () => {
    const result = await handler.handleToolCall('u4', 'update_team', {
      slug: 'my-team',
      field: 'container_config',
      value: { max_memory: '512m', max_old_space: 256 },
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('updated');

    const savedTeam = (configLoader.saveTeam as ReturnType<typeof vi.fn>).mock.calls.find(
      (c: unknown[]) => c[0] === 'my-team',
    )?.[1] as Team | undefined;
    expect(savedTeam?.container_config?.max_memory).toBe('512m');
    expect(savedTeam?.container_config?.max_old_space).toBe(256);
  });

  it('throws ValidationError when container_config.max_memory is not a string', async () => {
    await expect(
      handler.handleToolCall('u5', 'update_team', {
        slug: 'my-team',
        field: 'container_config',
        value: { max_memory: 512 },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for unknown field', async () => {
    await expect(
      handler.handleToolCall('u6', 'update_team', {
        slug: 'my-team',
        field: 'leader_aid',
        value: 'aid-new-00000001',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('u7', 'update_team', {
        slug: 'my-team',
        field: 'leader_aid',
        value: 'aid-new-00000001',
      }),
    ).rejects.toThrow('is not updatable');
  });

  it('throws ValidationError when field is missing', async () => {
    await expect(
      handler.handleToolCall('u8', 'update_team', {
        slug: 'my-team',
        value: { KEY: 'val' },
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when value is null', async () => {
    await expect(
      handler.handleToolCall('u9', 'update_team', {
        slug: 'my-team',
        field: 'env_vars',
        value: null,
      }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// get_member_status
// ---------------------------------------------------------------------------

describe('get_member_status', () => {
  it('returns agent info when agent_aid is provided', async () => {
    const result = await handler.handleToolCall('m1', 'get_member_status', {
      agent_aid: 'aid-lead-00000001',
    }) as Record<string, JsonValue>;

    expect(result['aid']).toBe('aid-lead-00000001');
    expect(result['name']).toBe('Lead Agent');
    expect(orgChart.getAgentByAID).toHaveBeenCalledWith('aid-lead-00000001');
  });

  it('returns team info when team_slug is provided', async () => {
    const result = await handler.handleToolCall('m2', 'get_member_status', {
      team_slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['slug']).toBe('my-team');
    expect(result['leader_aid']).toBe('aid-lead-00000001');
    expect(orgChart.getTeamBySlug).toHaveBeenCalledWith('my-team');
  });

  it('prefers agent_aid over team_slug when both provided', async () => {
    const result = await handler.handleToolCall('m3', 'get_member_status', {
      agent_aid: 'aid-lead-00000001',
      team_slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['aid']).toBe('aid-lead-00000001');
    expect(orgChart.getAgentByAID).toHaveBeenCalled();
    // getTeamBySlug should not be called when agent_aid is present
    expect(orgChart.getTeamBySlug).not.toHaveBeenCalled();
  });

  it('throws ValidationError when neither arg is provided', async () => {
    await expect(
      handler.handleToolCall('m4', 'get_member_status', {}),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('m5', 'get_member_status', {}),
    ).rejects.toThrow('either agent_aid or team_slug is required');
  });

  it('throws ValidationError for invalid AID format', async () => {
    await expect(
      handler.handleToolCall('m6', 'get_member_status', { agent_aid: 'badformat' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws NotFoundError for unknown agent', async () => {
    await expect(
      handler.handleToolCall('m7', 'get_member_status', { agent_aid: 'aid-ghost-00000000' }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws NotFoundError for unknown team', async () => {
    await expect(
      handler.handleToolCall('m8', 'get_member_status', { team_slug: 'ghost-team' }),
    ).rejects.toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// delete_agent
// ---------------------------------------------------------------------------

describe('delete_agent', () => {
  it('removes agent from a team config', async () => {
    const result = await handler.handleToolCall('da1', 'delete_agent', {
      aid: 'aid-lead-00000001',
      team_slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
    expect(result['aid']).toBe('aid-lead-00000001');
    expect(configLoader.saveTeam).toHaveBeenCalled();
  });

  it('removes agent from master config when team_slug is "master"', async () => {
    const result = await handler.handleToolCall('da2', 'delete_agent', {
      aid: 'aid-lead-00000001',
      team_slug: 'master',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
    expect(configLoader.saveMaster).toHaveBeenCalled();
  });

  it('throws ValidationError when agent leads a team', async () => {
    // Override orgChart to return lead teams for this agent
    const localOrgChart = makeMockOrgChart(
      { 'aid-lead-00000001': existingAgent },
      { 'my-team': existingTeam },
      { 'aid-lead-00000001': ['my-team'] },
    );
    const localDeps: TeamToolsDeps = { ...deps, orgChart: localOrgChart };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    await expect(
      localHandler.handleToolCall('da3', 'delete_agent', {
        aid: 'aid-lead-00000001',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      localHandler.handleToolCall('da4', 'delete_agent', {
        aid: 'aid-lead-00000001',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow('delete the team(s) first');
  });

  it('throws NotFoundError when agent not in team', async () => {
    await expect(
      handler.handleToolCall('da5', 'delete_agent', {
        aid: 'aid-ghost-00000000',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('throws ValidationError for invalid AID', async () => {
    await expect(
      handler.handleToolCall('da6', 'delete_agent', {
        aid: 'not-valid-aid',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError when team_slug is missing', async () => {
    await expect(
      handler.handleToolCall('da7', 'delete_agent', {
        aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('da8', 'delete_agent', {
        aid: 'aid-lead-00000001',
      }),
    ).rejects.toThrow('team_slug is required');
  });

  it('rebuilds orgchart after deleting an agent', async () => {
    await handler.handleToolCall('da9', 'delete_agent', {
      aid: 'aid-lead-00000001',
      team_slug: 'my-team',
    });
    expect(orgChart.rebuildFromConfig).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// create_skill
// ---------------------------------------------------------------------------

describe('create_skill', () => {
  it('calls mkdir and writeFile for the skill and returns { name, status: "created" }', async () => {
    const mockMkdir = fsMkdir as ReturnType<typeof vi.fn>;
    const mockWriteFile = fsWriteFile as ReturnType<typeof vi.fn>;
    mockMkdir.mockClear();
    mockWriteFile.mockClear();

    const result = await handler.handleToolCall('sk1', 'create_skill', {
      name: 'web-search',
      team_slug: 'my-team',
      body: 'Search the web for information.',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('created');
    expect(result['name']).toBe('web-search');

    // mkdir should be called with .claude/skills/web-search inside the workspace
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('/run/openhive/teams/my-team/.claude/skills/web-search'),
      { recursive: true },
    );

    // writeFile should write SKILL.md
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writeArgs = mockWriteFile.mock.calls[0] as [string, string, { mode: number }];
    expect(writeArgs[0]).toMatch(/SKILL\.md$/);
    expect(writeArgs[1]).toContain('name: web-search');
    expect(writeArgs[1]).toContain('Search the web for information.');
    expect(writeArgs[2]).toEqual({ mode: 0o644 });
  });

  it('uses "main" workspace slug when team_slug is "master"', async () => {
    const mockMkdir = fsMkdir as ReturnType<typeof vi.fn>;
    mockMkdir.mockClear();

    await handler.handleToolCall('sk2', 'create_skill', {
      name: 'code-review',
      team_slug: 'master',
      body: 'Review code thoroughly.',
    });

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining('/run/openhive/teams/main/.claude/skills/code-review'),
      { recursive: true },
    );
  });

  it('includes description in frontmatter when provided', async () => {
    const mockWriteFile = fsWriteFile as ReturnType<typeof vi.fn>;
    mockWriteFile.mockClear();

    await handler.handleToolCall('sk3', 'create_skill', {
      name: 'searcher',
      team_slug: 'my-team',
      description: 'Search the internet',
      body: 'Use DuckDuckGo.',
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writeArgs = mockWriteFile.mock.calls[0] as [string, string, { mode: number }];
    expect(writeArgs[1]).toContain('description: Search the internet');
  });

  it('includes argument-hint in frontmatter when argument_hint is provided', async () => {
    const mockWriteFile = fsWriteFile as ReturnType<typeof vi.fn>;
    mockWriteFile.mockClear();

    await handler.handleToolCall('sk4', 'create_skill', {
      name: 'query-skill',
      team_slug: 'my-team',
      argument_hint: 'the query string',
      body: 'Execute the query.',
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writeArgs = mockWriteFile.mock.calls[0] as [string, string, { mode: number }];
    expect(writeArgs[1]).toContain('argument-hint:');
    expect(writeArgs[1]).toContain('the query string');
  });

  it('includes allowed-tools in frontmatter when allowed_tools is provided', async () => {
    const mockWriteFile = fsWriteFile as ReturnType<typeof vi.fn>;
    mockWriteFile.mockClear();

    await handler.handleToolCall('sk5', 'create_skill', {
      name: 'browser-skill',
      team_slug: 'my-team',
      allowed_tools: ['browser_search', 'fetch_url'],
      body: 'Browse the web.',
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writeArgs = mockWriteFile.mock.calls[0] as [string, string, { mode: number }];
    expect(writeArgs[1]).toContain('allowed-tools:');
    expect(writeArgs[1]).toContain('browser_search');
    expect(writeArgs[1]).toContain('fetch_url');
  });

  it('throws ValidationError when name is missing', async () => {
    await expect(
      handler.handleToolCall('sk6', 'create_skill', {
        team_slug: 'my-team',
        body: 'Body.',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('sk7', 'create_skill', {
        team_slug: 'my-team',
        body: 'Body.',
      }),
    ).rejects.toThrow('name is required');
  });

  it('throws ValidationError when team_slug is missing', async () => {
    await expect(
      handler.handleToolCall('sk8', 'create_skill', {
        name: 'my-skill',
        body: 'Body.',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('sk9', 'create_skill', {
        name: 'my-skill',
        body: 'Body.',
      }),
    ).rejects.toThrow('team_slug is required');
  });

  it('throws ValidationError when body is missing', async () => {
    await expect(
      handler.handleToolCall('sk10', 'create_skill', {
        name: 'my-skill',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('sk11', 'create_skill', {
        name: 'my-skill',
        team_slug: 'my-team',
      }),
    ).rejects.toThrow('body is required');
  });

  it('throws ValidationError for skill name with path traversal', async () => {
    await expect(
      handler.handleToolCall('sk12', 'create_skill', {
        name: '../evil',
        team_slug: 'my-team',
        body: 'Body.',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('sk13', 'create_skill', {
        name: '../evil',
        team_slug: 'my-team',
        body: 'Body.',
      }),
    ).rejects.toThrow("must not contain '..'");
  });

  it('throws ValidationError for skill name with invalid characters', async () => {
    await expect(
      handler.handleToolCall('sk14', 'create_skill', {
        name: 'my skill!',
        team_slug: 'my-team',
        body: 'Body.',
      }),
    ).rejects.toThrow(ValidationError);
  });

  it('logs skill creation', async () => {
    await handler.handleToolCall('sk15', 'create_skill', {
      name: 'logged-skill',
      team_slug: 'my-team',
      body: 'Skill body.',
    });

    expect(deps.logger.info).toHaveBeenCalledWith(
      'skill created',
      expect.objectContaining({ name: 'logged-skill', team_slug: 'my-team' }),
    );
  });

  it('throws ValidationError when team_slug contains path traversal (../escape)', async () => {
    await expect(
      handler.handleToolCall('sk16', 'create_skill', {
        name: 'my-skill',
        team_slug: '../escape',
        body: 'Body.',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('sk17', 'create_skill', {
        name: 'my-skill',
        team_slug: '../escape',
        body: 'Body.',
      }),
    ).rejects.toThrow("must not contain '..'");
  });

  it('throws ValidationError when team_slug contains path separators', async () => {
    await expect(
      handler.handleToolCall('sk18', 'create_skill', {
        name: 'my-skill',
        team_slug: 'some/nested',
        body: 'Body.',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('sk19', 'create_skill', {
        name: 'my-skill',
        team_slug: 'some/nested',
        body: 'Body.',
      }),
    ).rejects.toThrow('must not contain path separators');
  });
});

// ---------------------------------------------------------------------------
// delete_team leader cleanup
// ---------------------------------------------------------------------------

describe('delete_team leader cleanup', () => {
  it('removes leader from master.agents after deleting team', async () => {
    const leaderAgent = makeAgent('aid-researcher-00000001', 'Researcher');
    const teamWithLeader = makeTeam('research-team', 'aid-researcher-00000001');
    const localMasterCfg = makeMasterConfig([leaderAgent]);

    const localConfigLoader = makeMockConfigLoader(localMasterCfg, { 'research-team': teamWithLeader });
    const localOrgChart = makeMockOrgChart(
      { 'aid-researcher-00000001': leaderAgent },
      { 'research-team': teamWithLeader },
      {},
    );
    const localDeps: TeamToolsDeps = {
      ...deps,
      configLoader: localConfigLoader,
      orgChart: localOrgChart,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    await localHandler.handleToolCall('lc1', 'delete_team', { slug: 'research-team' });

    expect(localConfigLoader.saveMaster).toHaveBeenCalled();
    const saveMasterCalls = (localConfigLoader.saveMaster as ReturnType<typeof vi.fn>).mock.calls;
    const lastSavedMaster = saveMasterCalls[saveMasterCalls.length - 1][0] as MasterConfig;
    const leaderInMaster = (lastSavedMaster.agents ?? []).find((a) => a.aid === 'aid-researcher-00000001');
    expect(leaderInMaster).toBeUndefined();
  });

  it('deletes leader .md from parent workspace', async () => {
    const leaderAgent = makeAgent('aid-researcher-00000001', 'Researcher');
    const teamWithLeader = makeTeam('research-team', 'aid-researcher-00000001');
    const localMasterCfg = makeMasterConfig([leaderAgent]);

    const localConfigLoader = makeMockConfigLoader(localMasterCfg, { 'research-team': teamWithLeader });
    const localOrgChart = makeMockOrgChart(
      { 'aid-researcher-00000001': leaderAgent },
      { 'research-team': teamWithLeader },
      {},
    );
    const localDeps: TeamToolsDeps = {
      ...deps,
      configLoader: localConfigLoader,
      orgChart: localOrgChart,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    await localHandler.handleToolCall('lc2', 'delete_team', { slug: 'research-team' });

    expect(fsUnlink).toHaveBeenCalledWith(
      '/run/openhive/teams/main/.claude/agents/researcher.md',
    );
  });

  it('tolerates ENOENT on leader .md deletion', async () => {
    const leaderAgent = makeAgent('aid-researcher-00000001', 'Researcher');
    const teamWithLeader = makeTeam('research-team', 'aid-researcher-00000001');
    const localMasterCfg = makeMasterConfig([leaderAgent]);

    const localConfigLoader = makeMockConfigLoader(localMasterCfg, { 'research-team': teamWithLeader });
    const localOrgChart = makeMockOrgChart(
      { 'aid-researcher-00000001': leaderAgent },
      { 'research-team': teamWithLeader },
      {},
    );
    const localDeps: TeamToolsDeps = {
      ...deps,
      configLoader: localConfigLoader,
      orgChart: localOrgChart,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    (fsUnlink as ReturnType<typeof vi.fn>).mockRejectedValueOnce(enoentError);

    const result = await localHandler.handleToolCall('lc3', 'delete_team', {
      slug: 'research-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
  });

  it('skips leader cleanup when leader AID not in orgchart', async () => {
    // orgChart.getAgentByAID throws NotFoundError for the leader
    const teamWithLeader = makeTeam('research-team', 'aid-ghost-00000001');
    const localMasterCfg = makeMasterConfig();

    const localConfigLoader = makeMockConfigLoader(localMasterCfg, { 'research-team': teamWithLeader });
    const localOrgChart = makeMockOrgChart(
      {},
      { 'research-team': teamWithLeader },
      {},
    );
    const localLogger = makeLogger();
    const localDeps: TeamToolsDeps = {
      ...deps,
      configLoader: localConfigLoader,
      orgChart: localOrgChart,
      logger: localLogger,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    // Should not throw
    const result = await localHandler.handleToolCall('lc4', 'delete_team', {
      slug: 'research-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
    expect(localLogger.warn).toHaveBeenCalledWith(
      'leader not found in orgchart during delete_team, skipping leader cleanup',
      expect.objectContaining({ leader_aid: 'aid-ghost-00000001' }),
    );
  });

  it('skips cleanup for main assistant (aid-main-001)', async () => {
    const teamWithMainAssistant = makeTeam('special-team', 'aid-main-001');
    const mainAssistant = makeAgent('aid-main-001', 'Hive');
    const localMasterCfg = makeMasterConfig();

    const localConfigLoader = makeMockConfigLoader(localMasterCfg, { 'special-team': teamWithMainAssistant });
    const localOrgChart = makeMockOrgChart(
      { 'aid-main-001': mainAssistant },
      { 'special-team': teamWithMainAssistant },
      {},
    );
    const localLogger = makeLogger();
    const localDeps: TeamToolsDeps = {
      ...deps,
      configLoader: localConfigLoader,
      orgChart: localOrgChart,
      logger: localLogger,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    await localHandler.handleToolCall('lc5', 'delete_team', { slug: 'special-team' });

    // saveMaster should NOT be called for leader cleanup (only for orgchart rebuild)
    // The unlink should NOT be called at all
    expect(fsUnlink).not.toHaveBeenCalled();
    expect(localLogger.info).toHaveBeenCalledWith(
      'skipping leader cleanup for main assistant',
      expect.objectContaining({ leader_aid: 'aid-main-001' }),
    );
  });

  it('skips agent deletion when leader leads other teams', async () => {
    const leaderAgent = makeAgent('aid-multi-00000001', 'Multi Leader');
    const team1 = makeTeam('team-a', 'aid-multi-00000001');
    const team2 = makeTeam('team-b', 'aid-multi-00000001');
    const localMasterCfg = makeMasterConfig([leaderAgent]);

    const localConfigLoader = makeMockConfigLoader(localMasterCfg, {
      'team-a': team1,
      'team-b': team2,
    });
    const localOrgChart = makeMockOrgChart(
      { 'aid-multi-00000001': leaderAgent },
      { 'team-a': team1, 'team-b': team2 },
      { 'aid-multi-00000001': ['team-a', 'team-b'] },
    );
    const localLogger = makeLogger();
    const localDeps: TeamToolsDeps = {
      ...deps,
      configLoader: localConfigLoader,
      orgChart: localOrgChart,
      logger: localLogger,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    await localHandler.handleToolCall('lc6', 'delete_team', { slug: 'team-a' });

    // Leader should still be in master.agents
    const masterAgents = localMasterCfg.agents ?? [];
    expect(masterAgents.find((a) => a.aid === 'aid-multi-00000001')).toBeDefined();
    expect(localLogger.info).toHaveBeenCalledWith(
      'leader leads other teams, skipping deletion',
      expect.objectContaining({ leader_aid: 'aid-multi-00000001' }),
    );
  });

  it('handles non-ENOENT unlink errors gracefully', async () => {
    const leaderAgent = makeAgent('aid-researcher-00000001', 'Researcher');
    const teamWithLeader = makeTeam('research-team', 'aid-researcher-00000001');
    const localMasterCfg = makeMasterConfig([leaderAgent]);

    const localConfigLoader = makeMockConfigLoader(localMasterCfg, { 'research-team': teamWithLeader });
    const localOrgChart = makeMockOrgChart(
      { 'aid-researcher-00000001': leaderAgent },
      { 'research-team': teamWithLeader },
      {},
    );
    const localLogger = makeLogger();
    const localDeps: TeamToolsDeps = {
      ...deps,
      configLoader: localConfigLoader,
      orgChart: localOrgChart,
      logger: localLogger,
    };
    const localHandler = new ToolHandler(makeLogger());
    registerTeamTools(localHandler, localDeps);

    const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    (fsUnlink as ReturnType<typeof vi.fn>).mockRejectedValueOnce(permError);

    // Should not throw — error is caught and logged
    const result = await localHandler.handleToolCall('lc7', 'delete_team', {
      slug: 'research-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
    expect(localLogger.warn).toHaveBeenCalledWith(
      'failed to delete leader .md file',
      expect.objectContaining({ leader_aid: 'aid-researcher-00000001' }),
    );
  });
});

// ---------------------------------------------------------------------------
// delete_agent .md file cleanup
// ---------------------------------------------------------------------------

describe('delete_agent .md file cleanup', () => {
  it('deletes agent .md from workspace', async () => {
    await handler.handleToolCall('damd1', 'delete_agent', {
      aid: 'aid-lead-00000001',
      team_slug: 'my-team',
    });

    expect(fsUnlink).toHaveBeenCalledWith(
      '/run/openhive/teams/my-team/.claude/agents/lead-agent.md',
    );
  });

  it('deletes agent .md from main workspace when team_slug is "master"', async () => {
    await handler.handleToolCall('damd2', 'delete_agent', {
      aid: 'aid-lead-00000001',
      team_slug: 'master',
    });

    expect(fsUnlink).toHaveBeenCalledWith(
      '/run/openhive/teams/main/.claude/agents/lead-agent.md',
    );
  });

  it('tolerates ENOENT on .md deletion', async () => {
    const enoentError = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    (fsUnlink as ReturnType<typeof vi.fn>).mockRejectedValueOnce(enoentError);

    const result = await handler.handleToolCall('damd3', 'delete_agent', {
      aid: 'aid-lead-00000001',
      team_slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'agent .md already removed',
      expect.objectContaining({ aid: 'aid-lead-00000001' }),
    );
  });

  it('handles non-ENOENT unlink errors gracefully', async () => {
    const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    (fsUnlink as ReturnType<typeof vi.fn>).mockRejectedValueOnce(permError);

    const result = await handler.handleToolCall('damd4', 'delete_agent', {
      aid: 'aid-lead-00000001',
      team_slug: 'my-team',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('deleted');
    expect(deps.logger.warn).toHaveBeenCalledWith(
      'failed to delete agent .md file',
      expect.objectContaining({ aid: 'aid-lead-00000001' }),
    );
  });
});

// ---------------------------------------------------------------------------
// create_agent .md body content
// ---------------------------------------------------------------------------

describe('create_agent .md body content', () => {
  it('writes meaningful body in .md file with description and guidelines', async () => {
    const mockWriteFile = fsWriteFile as ReturnType<typeof vi.fn>;
    mockWriteFile.mockClear();

    await handler.handleToolCall('body1', 'create_agent', {
      name: 'Data Analyst',
      description: 'Analyzes datasets and produces insights',
      team_slug: 'master',
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writeArgs = mockWriteFile.mock.calls[0] as [string, string, { mode: number }];
    const content = writeArgs[1];

    // Should contain the agent name as heading
    expect(content).toContain('# Data Analyst');
    // Should contain the description
    expect(content).toContain('Analyzes datasets and produces insights');
    // Should contain guidelines
    expect(content).toContain('## Guidelines');
    expect(content).toContain('Focus on tasks within your area of expertise');
    // Should NOT contain the old useless placeholder
    expect(content).not.toContain('Agent: Data Analyst');
  });

  it('writes derived body even with role_file fallback description', async () => {
    const mockWriteFile = fsWriteFile as ReturnType<typeof vi.fn>;
    mockWriteFile.mockClear();

    await handler.handleToolCall('body2', 'create_agent', {
      name: 'Helper',
      role_file: '/some/path.md',
      team_slug: 'master',
    });

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const writeArgs = mockWriteFile.mock.calls[0] as [string, string, { mode: number }];
    const content = writeArgs[1];

    // Should contain the agent name heading and guidelines
    expect(content).toContain('# Helper');
    expect(content).toContain('## Guidelines');
  });
});
