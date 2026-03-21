/**
 * Layer 8 Phase Gate: ToolCallDispatcher
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { ToolCallDispatcher } from '../control-plane/tool-call-dispatcher.js';
import { AgentRole, AgentStatus } from '../domain/enums.js';
import { RateLimitedError, AccessDeniedError, NotFoundError } from '../domain/errors.js';
import type { OrgChart, OrgChartAgent, MCPRegistry, ToolCallStore, Logger, LogStore } from '../domain/interfaces.js';
import { createMockOrgChart, createMockMCPRegistry, createMockToolCallStore, createMockLogger, createMockLogStore } from './__layer-8-helpers.js';
import { EventBusImpl } from '../control-plane/event-bus.js';

describe('Layer 8: ToolCallDispatcher', () => {
  let logger: Logger;
  let logStore: LogStore;
  let eventBus: EventBusImpl;

  beforeEach(() => {
    logger = createMockLogger();
    logStore = createMockLogStore();
    eventBus = new EventBusImpl();
  });

  afterEach(() => {
    eventBus.close();
  });

  describe('ToolCallDispatcher full flow', () => {
    let dispatcher: ToolCallDispatcher;
    let orgChart: OrgChart;
    let mcpRegistry: MCPRegistry;
    let toolCallStore: ToolCallStore;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      orgChart = createMockOrgChart();
      mcpRegistry = createMockMCPRegistry();
      toolCallStore = createMockToolCallStore();
      handler = vi.fn().mockResolvedValue({ result: 'success' });

      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('test_tool', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });
    });

    it('executes tool and logs to ToolCallStore', async () => {
      const callId = crypto.randomUUID();

      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

      const result = await dispatcher.handleToolCall(
        'aid-test',
        'test_tool',
        { param: 'value' },
        callId,
      );

      expect(result).toEqual({ result: 'success' });
      expect(handler).toHaveBeenCalledWith({ param: 'value' }, 'aid-test', 'team-a');
      expect(toolCallStore.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tool_use_id: callId,
          tool_name: 'test_tool',
          agent_aid: 'aid-test',
          team_slug: 'team-a',
        }),
      );
    });

    it('denies unauthorized tool', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(false);

      await expect(
        dispatcher.handleToolCall('aid-test', 'test_tool', {}, crypto.randomUUID()),
      ).rejects.toThrow(AccessDeniedError);
    });

    it('denies unknown agent', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue(undefined);

      await expect(
        dispatcher.handleToolCall('aid-unknown', 'test_tool', {}, crypto.randomUUID()),
      ).rejects.toThrow(NotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Tool Call Dedup
  // -------------------------------------------------------------------------

  describe('ToolCallDispatcher dedup', () => {
    let dispatcher: ToolCallDispatcher;
    let orgChart: OrgChart;
    let mcpRegistry: MCPRegistry;
    let toolCallStore: ToolCallStore;
    let handler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      orgChart = createMockOrgChart();
      mcpRegistry = createMockMCPRegistry();
      toolCallStore = createMockToolCallStore();
      handler = vi.fn().mockResolvedValue({ result: 'success' });

      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('test_tool', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });
    });

    it('returns cached result for duplicate call_id', async () => {
      const callId = crypto.randomUUID();

      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

      // First call
      const result1 = await dispatcher.handleToolCall(
        'aid-test',
        'test_tool',
        { param: 'first' },
        callId,
      );

      // Second call with same call_id
      const result2 = await dispatcher.handleToolCall(
        'aid-test',
        'test_tool',
        { param: 'second' }, // Different args
        callId,
      );

      expect(result1).toEqual(result2);
      // Handler should only be called once (second was cached)
      expect(handler).toHaveBeenCalledTimes(1);
      // ToolCallStore should only be written once
      expect(toolCallStore.create).toHaveBeenCalledTimes(1);
    });

    it('different call_ids execute separately', async () => {
      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);

      await dispatcher.handleToolCall('aid-test', 'test_tool', {}, crypto.randomUUID());
      await dispatcher.handleToolCall('aid-test', 'test_tool', {}, crypto.randomUUID());

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Rate Limiting
  // -------------------------------------------------------------------------

  describe('ToolCallDispatcher rate limiting', () => {
    let dispatcher: ToolCallDispatcher;
    let orgChart: OrgChart;
    let mcpRegistry: MCPRegistry;
    let toolCallStore: ToolCallStore;

    beforeEach(() => {
      orgChart = createMockOrgChart();
      mcpRegistry = createMockMCPRegistry();
      toolCallStore = createMockToolCallStore();

      vi.mocked(orgChart.getAgent).mockReturnValue({
        aid: 'aid-test',
        teamSlug: 'team-a',
        role: AgentRole.Member,
        name: 'Test Agent',
        status: AgentStatus.Idle,
      } as OrgChartAgent);
      vi.mocked(mcpRegistry.isAllowed).mockReturnValue(true);
    });

    it('rejects 6th create_team call within 1 minute', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('create_team', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });

      // create_team has limit of 5/minute
      for (let i = 0; i < 5; i++) {
        await dispatcher.handleToolCall('aid-test', 'create_team', {}, crypto.randomUUID());
      }

      // 6th call should fail
      await expect(
        dispatcher.handleToolCall('aid-test', 'create_team', {}, crypto.randomUUID()),
      ).rejects.toThrow(RateLimitedError);
    });

    it('allows 30 dispatch_subtask calls within 1 minute', async () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('dispatch_subtask', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });

      // dispatch_subtask has limit of 30/minute
      for (let i = 0; i < 30; i++) {
        await dispatcher.handleToolCall('aid-test', 'dispatch_subtask', {}, crypto.randomUUID());
      }

      // 31st call should fail
      await expect(
        dispatcher.handleToolCall('aid-test', 'dispatch_subtask', {}, crypto.randomUUID()),
      ).rejects.toThrow(RateLimitedError);
    });

    it('cleanupAgent removes rate limiter entry', () => {
      const handler = vi.fn().mockResolvedValue({ success: true });
      const handlers = new Map<string, (args: Record<string, unknown>, agentAid: string, teamSlug: string) => Promise<Record<string, unknown>>>();
      handlers.set('create_team', handler);

      dispatcher = new ToolCallDispatcher({
        orgChart,
        mcpRegistry,
        logStore,
        toolCallStore,
        logger,
        handlers,
      });

      // Trigger rate limiter creation
      (dispatcher as unknown as { rateLimiters: Map<string, unknown> }).rateLimiters.set('aid-test', { timestamps: [] });

      dispatcher.cleanupAgent('aid-test');

      expect((dispatcher as unknown as { rateLimiters: Map<string, unknown> }).rateLimiters.has('aid-test')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Task DAG
  // -------------------------------------------------------------------------

});
