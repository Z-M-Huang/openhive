/**
 * Tests for ToolHandler (backend/src/orchestrator/toolhandler.ts)
 *
 * Tests cover:
 *   1. Registered tool handlers are invoked correctly.
 *   2. Unknown tool name throws NotFoundError.
 *   3. Empty teamID throws AccessDeniedError.
 *   4. Any team can call any registered tool (no whitelist).
 *   5. Main team can access all tools.
 *   6. Agent AID ownership validated via OrgChart.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolHandler, newToolHandler } from './toolhandler.js';
import type { ToolHandlerLogger } from './toolhandler.js';
import { AccessDeniedError, NotFoundError } from '../domain/errors.js';
import type { OrgChart } from '../domain/interfaces.js';
import type { Agent, Team, JsonValue, MasterConfig } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Logger stub
// ---------------------------------------------------------------------------

function makeLogger(): ToolHandlerLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// OrgChart stub helpers
// ---------------------------------------------------------------------------

function makeAgent(aid: string): Agent {
  return { aid, name: `agent-${aid}` };
}

function makeTeam(slug: string, agentAIDs: string[]): Team {
  return {
    tid: `tid-${slug}`,
    slug,
    leader_aid: agentAIDs[0] ?? '',
    agents: agentAIDs.map(makeAgent),
  };
}

/**
 * Creates a minimal OrgChart mock that knows about the given agents/teams.
 * getAgentByAID throws NotFoundError for unknown AIDs.
 * getTeamForAgent returns the team that contains the agent.
 */
function makeOrgChart(teams: Team[]): OrgChart {
  const agentToTeam = new Map<string, Team>();
  const agentMap = new Map<string, Agent>();

  for (const team of teams) {
    for (const agent of team.agents ?? []) {
      agentToTeam.set(agent.aid, team);
      agentMap.set(agent.aid, agent);
    }
  }

  return {
    getOrgChart: vi.fn(() => {
      const result: Record<string, Team> = {};
      for (const t of teams) result[t.slug] = t;
      return result;
    }),
    getAgentByAID: vi.fn((aid: string): Agent => {
      const agent = agentMap.get(aid);
      if (agent === undefined) throw new NotFoundError('agent', aid);
      return agent;
    }),
    getTeamBySlug: vi.fn((slug: string): Team => {
      const team = teams.find((t) => t.slug === slug);
      if (team === undefined) throw new NotFoundError('team', slug);
      return team;
    }),
    getTeamForAgent: vi.fn((aid: string): Team => {
      const team = agentToTeam.get(aid);
      if (team === undefined) throw new NotFoundError('team_for_agent', aid);
      return team;
    }),
    getLeadTeams: vi.fn(() => []),
    getSubordinates: vi.fn(() => []),
    getSupervisor: vi.fn(() => null),
    rebuildFromConfig: vi.fn((_master: MasterConfig, _teams: Record<string, Team>) => {
      // no-op stub
    }),
  };
}

// ---------------------------------------------------------------------------
// Simple async tool handlers
// ---------------------------------------------------------------------------

function echoTool(args: Record<string, JsonValue>): Promise<JsonValue> {
  return Promise.resolve(args);
}

function greetTool(_args: Record<string, JsonValue>): Promise<JsonValue> {
  return Promise.resolve('hello');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ToolHandler', () => {
  let logger: ToolHandlerLogger;
  let handler: ToolHandler;

  beforeEach(() => {
    logger = makeLogger();
    handler = newToolHandler(logger);
  });

  // -------------------------------------------------------------------------
  // Test 1: registered tool handlers are invoked correctly
  // -------------------------------------------------------------------------

  it('invokes a registered tool handler with the correct args', async () => {
    const mockFn = vi.fn(echoTool);
    handler.register('echo', mockFn);

    const args: Record<string, JsonValue> = { greeting: 'hi', count: 3 };
    const result = await handler.handleToolCall('call-1', 'echo', args);

    expect(mockFn).toHaveBeenCalledOnce();
    // Tool function receives args + ToolCallContext (teamSlug, agentAid).
    expect(mockFn).toHaveBeenCalledWith(args, { teamSlug: 'main', agentAid: '' });
    expect(result).toEqual(args);
  });

  it('returns the result from the registered handler', async () => {
    handler.register('greet', greetTool);

    const result = await handler.handleToolCall('call-2', 'greet', {});
    expect(result).toBe('hello');
  });

  it('logs info on successful tool call', async () => {
    handler.register('greet', greetTool);
    await handler.handleToolCall('call-3', 'greet', {});

    expect(logger.info).toHaveBeenCalledWith(
      'handling tool call',
      expect.objectContaining({ call_id: 'call-3', tool_name: 'greet' }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      'tool call completed',
      expect.objectContaining({ call_id: 'call-3', tool_name: 'greet' }),
    );
  });

  // -------------------------------------------------------------------------
  // Test 2: unknown tool name throws NotFoundError
  // -------------------------------------------------------------------------

  it('throws NotFoundError for an unregistered tool name', async () => {
    await expect(
      handler.handleToolCall('call-4', 'unknown_tool', {}),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('NotFoundError has resource="tool" and id=toolName', async () => {
    try {
      await handler.handleToolCall('call-5', 'missing_tool', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError);
      const nfe = err as NotFoundError;
      expect(nfe.resource).toBe('tool');
      expect(nfe.id).toBe('missing_tool');
    }
  });

  // -------------------------------------------------------------------------
  // Test 3: empty teamID throws AccessDeniedError
  // -------------------------------------------------------------------------

  it('throws AccessDeniedError when teamID is empty string', async () => {
    handler.register('get_config', echoTool);

    await expect(
      handler.handleToolCallWithContext('', 'call-6', 'get_config', '', {}),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('logs a warning when teamID is empty', async () => {
    handler.register('get_config', echoTool);

    try {
      await handler.handleToolCallWithContext('', 'call-7', 'get_config', '', {});
    } catch {
      // expected
    }

    expect(logger.warn).toHaveBeenCalledWith(
      'tool call rejected: empty teamID',
      expect.objectContaining({ call_id: 'call-7', tool_name: 'get_config' }),
    );
  });

  it('AccessDeniedError message mentions unauthenticated', async () => {
    handler.register('get_config', echoTool);

    try {
      await handler.handleToolCallWithContext('', 'call-8', 'get_config', '', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccessDeniedError);
      expect((err as AccessDeniedError).message).toContain('unauthenticated');
    }
  });

  // -------------------------------------------------------------------------
  // Test 4: any team can call any registered tool (no whitelist)
  // -------------------------------------------------------------------------

  it('child team can call any registered tool', async () => {
    handler.register('create_team', echoTool);

    const result = await handler.handleToolCallWithContext(
      'child-team',
      'call-9',
      'create_team',
      '',
      { slug: 'sub' },
    );
    expect(result).toEqual({ slug: 'sub' });
  });

  it('child team can call admin-style tools like delete_agent', async () => {
    handler.register('delete_agent', echoTool);

    const result = await handler.handleToolCallWithContext(
      'child-team',
      'call-10',
      'delete_agent',
      '',
      { aid: 'aid-1' },
    );
    expect(result).toEqual({ aid: 'aid-1' });
  });

  it('nested team can call create_team for recursive sub-teams', async () => {
    handler.register('create_team', echoTool);
    handler.register('create_agent', echoTool);

    const result1 = await handler.handleToolCallWithContext(
      'nested-team',
      'call-11a',
      'create_agent',
      '',
      { name: 'sub-lead' },
    );
    expect(result1).toEqual({ name: 'sub-lead' });

    const result2 = await handler.handleToolCallWithContext(
      'nested-team',
      'call-11b',
      'create_team',
      '',
      { slug: 'sub-sub' },
    );
    expect(result2).toEqual({ slug: 'sub-sub' });
  });

  // -------------------------------------------------------------------------
  // Test 5: main team can access all tools
  // -------------------------------------------------------------------------

  it('main team can call admin-only tools', async () => {
    handler.register('create_team', echoTool);

    const result = await handler.handleToolCallWithContext(
      'main',
      'call-12',
      'create_team',
      '',
      { slug: 'new-team' },
    );
    expect(result).toEqual({ slug: 'new-team' });
  });

  it('main team can call all whitelisted tools too', async () => {
    handler.register('get_config', echoTool);

    const result = await handler.handleToolCallWithContext(
      'main',
      'call-13',
      'get_config',
      '',
      {},
    );
    expect(result).toEqual({});
  });

  it('main team can call handleToolCall (context-free)', async () => {
    handler.register('greet', greetTool);
    const result = await handler.handleToolCall('call-14', 'greet', {});
    expect(result).toBe('hello');
  });

  // -------------------------------------------------------------------------
  // Test 7: agent AID ownership validated via OrgChart
  // -------------------------------------------------------------------------

  it('allows call when agent belongs to the calling team', async () => {
    const teamA = makeTeam('team-a', ['aid-1']);
    const orgChart = makeOrgChart([teamA]);
    handler.setOrgChart(orgChart);
    handler.register('get_config', echoTool);

    const result = await handler.handleToolCallWithContext(
      'team-a',
      'call-15',
      'get_config',
      'aid-1',
      {},
    );
    expect(result).toEqual({});
  });

  it('throws AccessDeniedError when agent AID is unknown to OrgChart', async () => {
    const orgChart = makeOrgChart([]);
    handler.setOrgChart(orgChart);
    handler.register('get_config', echoTool);

    await expect(
      handler.handleToolCallWithContext('child-team', 'call-16', 'get_config', 'unknown-aid', {}),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('AccessDeniedError mentions unknown agent AID', async () => {
    const orgChart = makeOrgChart([]);
    handler.setOrgChart(orgChart);
    handler.register('get_config', echoTool);

    try {
      await handler.handleToolCallWithContext(
        'child-team',
        'call-17',
        'get_config',
        'ghost-aid',
        {},
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccessDeniedError);
      expect((err as AccessDeniedError).message).toContain('ghost-aid');
    }
  });

  it('throws AccessDeniedError when agent belongs to a different team', async () => {
    const teamA = makeTeam('team-a', ['aid-1']);
    const teamB = makeTeam('team-b', ['aid-2']);
    const orgChart = makeOrgChart([teamA, teamB]);
    handler.setOrgChart(orgChart);
    handler.register('get_config', echoTool);

    // aid-1 belongs to team-a, but call claims to be from team-b
    await expect(
      handler.handleToolCallWithContext('team-b', 'call-18', 'get_config', 'aid-1', {}),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('AccessDeniedError mentions wrong-team agent', async () => {
    const teamA = makeTeam('team-a', ['aid-1']);
    const teamB = makeTeam('team-b', ['aid-2']);
    const orgChart = makeOrgChart([teamA, teamB]);
    handler.setOrgChart(orgChart);
    handler.register('get_config', echoTool);

    try {
      await handler.handleToolCallWithContext('team-b', 'call-19', 'get_config', 'aid-1', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AccessDeniedError);
      const msg = (err as AccessDeniedError).message;
      expect(msg).toContain('aid-1');
      expect(msg).toContain('team-b');
    }
  });

  it('main team bypasses agent team ownership check', async () => {
    // aid-1 belongs to team-a, but main team call should bypass the ownership check.
    const teamA = makeTeam('team-a', ['aid-1']);
    const orgChart = makeOrgChart([teamA]);
    handler.setOrgChart(orgChart);
    handler.register('create_team', echoTool);

    // Should NOT throw even though aid-1 is in team-a, not main
    const result = await handler.handleToolCallWithContext(
      'main',
      'call-20',
      'create_team',
      'aid-1',
      { slug: 'x' },
    );
    expect(result).toEqual({ slug: 'x' });
  });

  it('skips OrgChart check when agentAID is empty', async () => {
    const orgChart = makeOrgChart([]);
    handler.setOrgChart(orgChart);
    handler.register('get_config', echoTool);

    // agentAID is empty — no ownership check, should succeed
    const result = await handler.handleToolCallWithContext(
      'child-team',
      'call-21',
      'get_config',
      '',
      {},
    );
    expect(result).toEqual({});

    // getAgentByAID should NOT have been called
    expect(orgChart.getAgentByAID).not.toHaveBeenCalled();
  });

  it('skips OrgChart check when orgChart is not set', async () => {
    // No setOrgChart() call — handler.orgChart is null
    handler.register('get_config', echoTool);

    const result = await handler.handleToolCallWithContext(
      'child-team',
      'call-22',
      'get_config',
      'any-aid',
      {},
    );
    expect(result).toEqual({});
  });

  // -------------------------------------------------------------------------
  // Miscellaneous: registeredTools
  // -------------------------------------------------------------------------

  it('registeredTools returns names of all registered tools', () => {
    handler.register('tool_a', echoTool);
    handler.register('tool_b', echoTool);
    handler.register('tool_c', echoTool);

    const names = handler.registeredTools();
    expect(names).toHaveLength(3);
    expect(names).toContain('tool_a');
    expect(names).toContain('tool_b');
    expect(names).toContain('tool_c');
  });

  it('registeredTools returns empty array when no tools are registered', () => {
    expect(handler.registeredTools()).toEqual([]);
  });

  it('overwriting a tool registration replaces the handler', async () => {
    const firstFn = vi.fn(() => Promise.resolve('first' as JsonValue));
    const secondFn = vi.fn(() => Promise.resolve('second' as JsonValue));

    handler.register('my_tool', firstFn);
    handler.register('my_tool', secondFn);

    const result = await handler.handleToolCall('call-23', 'my_tool', {});
    expect(result).toBe('second');
    expect(firstFn).not.toHaveBeenCalled();
    expect(secondFn).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Error propagation: handler errors are rethrown
  // -------------------------------------------------------------------------

  it('propagates errors thrown by the tool handler function', async () => {
    const err = new Error('tool exploded');
    handler.register('boom', () => Promise.reject(err));

    await expect(handler.handleToolCall('call-24', 'boom', {})).rejects.toThrow('tool exploded');
  });

  it('logs error when tool handler function throws', async () => {
    handler.register('boom', () => Promise.reject(new Error('kaboom')));

    try {
      await handler.handleToolCall('call-25', 'boom', {});
    } catch {
      // expected
    }

    expect(logger.error).toHaveBeenCalledWith(
      'tool call failed',
      expect.objectContaining({ call_id: 'call-25', tool_name: 'boom' }),
    );
  });
});
