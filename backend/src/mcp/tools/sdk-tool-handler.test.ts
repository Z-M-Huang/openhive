/**
 * Tests for SDKToolHandler: authorization, handler logic, error mapping,
 * logging, and validation.
 *
 * @module mcp/tools/sdk-tool-handler.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SDKToolHandler, createToolHandlers } from './index.js';
import type { ToolContext } from './index.js';
import type { MemoryEntry } from '../../domain/index.js';
import { TaskStatus, IntegrationStatus, WSErrorCode } from '../../domain/index.js';
import { createMockContext, makeAgent, makeTask, makeTeam } from './__test-helpers.js';

describe('SDKToolHandler', () => {
  let ctx: ToolContext;
  let handler: SDKToolHandler;

  beforeEach(() => {
    ctx = createMockContext();
    handler = new SDKToolHandler(ctx, createToolHandlers(ctx));
  });

  // -----------------------------------------------------------------------
  // Authorization
  // -----------------------------------------------------------------------

  describe('authorization', () => {
    it('rejects when MCPRegistry.isAllowed returns false', async () => {
      vi.mocked(ctx.mcpRegistry.isAllowed).mockReturnValue(false);

      const result = await handler.handle(
        'spawn_container',
        { team_slug: 'alpha' },
        'aid-bob-001',
        'call-001',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.AccessDenied);
      expect(result.error_message).toContain('not authorized');
    });

    it('allows when MCPRegistry.isAllowed returns true', async () => {
      vi.mocked(ctx.mcpRegistry.isAllowed).mockReturnValue(true);

      const result = await handler.handle(
        'list_containers',
        {},
        'aid-alice-001',
        'call-002',
      );

      expect(result.success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Container tools
  // -----------------------------------------------------------------------

  describe('spawn_container', () => {
    it('calls containerManager.spawnTeamContainer and returns result', async () => {
      const result = await handler.handle(
        'spawn_container',
        { team_slug: 'alpha' },
        'aid-alice-001',
        'call-003',
      );

      expect(result.success).toBe(true);
      expect(result.result?.container_id).toBe('cid-alpha');
      expect(result.result?.connected).toBe(true);
      expect(ctx.containerManager.spawnTeamContainer).toHaveBeenCalledWith('alpha');
    });
  });

  describe('stop_container', () => {
    it('calls containerManager.stopTeamContainer', async () => {
      const result = await handler.handle(
        'stop_container',
        { team_slug: 'beta' },
        'aid-alice-001',
        'call-004',
      );

      expect(result.success).toBe(true);
      expect(result.result?.final_status).toBe('stopped');
      expect(ctx.containerManager.stopTeamContainer).toHaveBeenCalledWith('beta', 'Tool: stop_container');
    });
  });

  describe('list_containers', () => {
    it('returns running containers', async () => {
      const result = await handler.handle(
        'list_containers',
        {},
        'aid-alice-001',
        'call-005',
      );

      expect(result.success).toBe(true);
      const containers = (result.result as Record<string, unknown>)['containers'] as unknown[];
      expect(containers).toHaveLength(1);
    });
  });

  // -----------------------------------------------------------------------
  // Task tools
  // -----------------------------------------------------------------------

  describe('create_task', () => {
    it('creates task and returns task_id', async () => {
      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-alice-001', prompt: 'Do something useful' },
        'aid-alice-001',
        'call-010',
      );

      expect(result.success).toBe(true);
      expect(result.result?.task_id).toBeDefined();
      expect(typeof result.result?.task_id).toBe('string');
      expect(ctx.taskStore.create).toHaveBeenCalledOnce();
    });

    it('validates dependencies when blocked_by is provided', async () => {
      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-alice-001', prompt: 'Depends on task-x', blocked_by: ['task-x'] },
        'aid-alice-001',
        'call-011',
      );

      expect(result.success).toBe(true);
      expect(ctx.taskStore.validateDependencies).toHaveBeenCalled();
    });
  });

  describe('update_task_status', () => {
    it('validates state transition and updates task', async () => {
      // active -> completed is valid
      vi.mocked(ctx.taskStore.get).mockResolvedValue(makeTask({ status: TaskStatus.Active }));

      const result = await handler.handle(
        'update_task_status',
        { task_id: 'task-001', status: 'completed', result: 'Done!' },
        'aid-alice-001',
        'call-012',
      );

      expect(result.success).toBe(true);
      expect(result.result?.status).toBe('completed');
      expect(ctx.taskStore.update).toHaveBeenCalledOnce();
    });

    it('rejects invalid state transition', async () => {
      // completed -> active is invalid
      vi.mocked(ctx.taskStore.get).mockResolvedValue(makeTask({ status: TaskStatus.Completed }));

      const result = await handler.handle(
        'update_task_status',
        { task_id: 'task-001', status: 'active' },
        'aid-alice-001',
        'call-013',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.ValidationError);
      expect(result.error_message).toContain('Invalid task state transition');
    });
  });

  describe('dispatch_subtask', () => {
    it('creates subtask with parent_task_id', async () => {
      const result = await handler.handle(
        'dispatch_subtask',
        {
          agent_aid: 'aid-alice-001',
          prompt: 'Sub-work',
          parent_task_id: 'task-001',
        },
        'aid-alice-001',
        'call-014',
      );

      expect(result.success).toBe(true);
      expect(result.result?.task_id).toBeDefined();
      expect(ctx.taskStore.get).toHaveBeenCalledWith('task-001');
    });

    it('sends task_dispatch wire message with blocked_by (not parent_task_id)', async () => {
      const result = await handler.handle(
        'dispatch_subtask',
        {
          agent_aid: 'aid-alice-001',
          prompt: 'Sub-work',
          parent_task_id: 'task-001',
          blocked_by: ['task-002', 'task-003'],
        },
        'aid-alice-001',
        'call-014b',
      );

      expect(result.success).toBe(true);
      expect(ctx.wsHub.send).toHaveBeenCalledOnce();

      const [_tid, message] = vi.mocked(ctx.wsHub.send).mock.calls[0];
      expect(message.type).toBe('task_dispatch');
      const data = (message as { type: string; data: Record<string, unknown> }).data;
      expect(data['blocked_by']).toEqual(['task-002', 'task-003']);
      expect(data).not.toHaveProperty('parent_task_id');
    });

    it('sends blocked_by as empty array when not provided', async () => {
      await handler.handle(
        'dispatch_subtask',
        {
          agent_aid: 'aid-alice-001',
          prompt: 'Sub-work',
          parent_task_id: 'task-001',
        },
        'aid-alice-001',
        'call-014c',
      );

      expect(ctx.wsHub.send).toHaveBeenCalledOnce();
      const [_tid, message] = vi.mocked(ctx.wsHub.send).mock.calls[0];
      const data = (message as { type: string; data: Record<string, unknown> }).data;
      expect(data['blocked_by']).toEqual([]);
      expect(data).not.toHaveProperty('parent_task_id');
    });
  });

  // -----------------------------------------------------------------------
  // Memory tools (dual-write)
  // -----------------------------------------------------------------------

  describe('save_memory', () => {
    it('dual-writes: calls memoryStore.save', async () => {
      const result = await handler.handle(
        'save_memory',
        { content: 'Important fact', memory_type: 'curated' },
        'aid-alice-001',
        'call-020',
      );

      expect(result.success).toBe(true);
      expect(result.result?.status).toBe('saved');
      expect(result.result?.memory_id).toBeDefined();
      expect(ctx.memoryStore.save).toHaveBeenCalledOnce();

      // Verify the save call has the right agent_aid
      const savedEntry = vi.mocked(ctx.memoryStore.save).mock.calls[0][0];
      expect(savedEntry.agent_aid).toBe('aid-alice-001');
      expect(savedEntry.content).toBe('Important fact');
      expect(savedEntry.memory_type).toBe('curated');
    });
  });

  describe('recall_memory', () => {
    it('searches memoryStore with agent AID', async () => {
      const mockMemory: MemoryEntry = {
        id: 1,
        agent_aid: 'aid-alice-001',
        team_slug: 'test-team',
        content: 'Remembered fact',
        memory_type: 'curated',
        created_at: Date.now(),
        deleted_at: null,
      };
      vi.mocked(ctx.memoryStore.searchHybrid).mockResolvedValue([mockMemory]);

      const result = await handler.handle(
        'recall_memory',
        { query: 'fact' },
        'aid-alice-001',
        'call-021',
      );

      expect(result.success).toBe(true);
      const memories = (result.result as Record<string, unknown>)['memories'] as unknown[];
      expect(memories).toHaveLength(1);
      expect(ctx.memoryStore.searchHybrid).toHaveBeenCalledWith(
        'fact',
        'aid-alice-001',
        undefined, // no embedding service configured
        10,
      );
    });
  });

  // -----------------------------------------------------------------------
  // Messaging
  // -----------------------------------------------------------------------

  describe('send_message', () => {
    it('stores message and sends agent_message via WS', async () => {
      const result = await handler.handle(
        'send_message',
        { target_aid: 'aid-bob-002', content: 'Hello!' },
        'aid-alice-001',
        'call-030',
      );

      expect(result.success).toBe(true);
      expect(result.result?.delivered).toBe(true);
      expect(ctx.messageStore.create).toHaveBeenCalledOnce();
      expect(ctx.wsHub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'agent_message',
          data: expect.objectContaining({
            source_aid: 'aid-alice-001',
            target_aid: 'aid-bob-002',
            content: 'Hello!',
          }),
        }),
      );
    });

    it('sends agent_message with provided correlation_id', async () => {
      const result = await handler.handle(
        'send_message',
        { target_aid: 'aid-bob-002', content: 'Hi', correlation_id: 'corr-xyz-123' },
        'aid-alice-001',
        'call-032',
      );

      expect(result.success).toBe(true);
      expect(ctx.wsHub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'agent_message',
          data: expect.objectContaining({
            correlation_id: 'corr-xyz-123',
          }),
        }),
      );
    });

    it('generates correlation_id when not provided', async () => {
      await handler.handle(
        'send_message',
        { target_aid: 'aid-bob-002', content: 'Hi' },
        'aid-alice-001',
        'call-033',
      );

      expect(ctx.wsHub.send).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          type: 'agent_message',
          data: expect.objectContaining({
            correlation_id: expect.any(String),
          }),
        }),
      );
    });

    it('returns error for unknown target agent', async () => {
      vi.mocked(ctx.orgChart.getAgent).mockImplementation((aid: string) => {
        if (aid === 'aid-alice-001') return makeAgent();
        return undefined;
      });

      const result = await handler.handle(
        'send_message',
        { target_aid: 'aid-nonexistent-999', content: 'Hello?' },
        'aid-alice-001',
        'call-031',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });
  });

  // -----------------------------------------------------------------------
  // Escalation
  // -----------------------------------------------------------------------

  describe('escalate', () => {
    it('transitions task to escalated and publishes event', async () => {
      vi.mocked(ctx.taskStore.get).mockResolvedValue(makeTask({ status: TaskStatus.Active }));

      const result = await handler.handle(
        'escalate',
        { task_id: 'task-001', reason: 'need_guidance', context: { detail: 'stuck' } },
        'aid-alice-001',
        'call-040',
      );

      expect(result.success).toBe(true);
      expect(result.result?.correlation_id).toBeDefined();
      expect(ctx.taskStore.update).toHaveBeenCalledOnce();
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'task.escalated' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Integration tools
  // -----------------------------------------------------------------------

  describe('create_integration', () => {
    it('creates integration in proposed state', async () => {
      const result = await handler.handle(
        'create_integration',
        { name: 'slack-bot', type: 'slack', config: { token: 'xxx' } },
        'aid-alice-001',
        'call-050',
      );

      expect(result.success).toBe(true);
      expect(result.result?.integration_id).toBeDefined();
      expect(result.result?.config_path).toContain('slack-bot');
      expect(ctx.integrationStore.create).toHaveBeenCalledOnce();
    });
  });

  describe('test_integration', () => {
    it('transitions proposed integration to tested', async () => {
      const result = await handler.handle(
        'test_integration',
        { integration_id: 'int-001' },
        'aid-alice-001',
        'call-051',
      );

      expect(result.success).toBe(true);
      expect(result.result?.success).toBe(true);
      expect(ctx.integrationStore.updateStatus).toHaveBeenCalledWith('int-001', IntegrationStatus.Tested);
    });

    it('rejects testing an already active integration', async () => {
      vi.mocked(ctx.integrationStore.get).mockResolvedValue({
        id: 'int-001',
        team_id: 'test-team',
        name: 'test',
        config_path: '/path',
        status: IntegrationStatus.Active,
        error_message: '',
        created_at: Date.now(),
      });

      const result = await handler.handle(
        'test_integration',
        { integration_id: 'int-001' },
        'aid-alice-001',
        'call-052',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.ValidationError);
    });
  });

  describe('activate_integration', () => {
    it('transitions tested integration to active', async () => {
      vi.mocked(ctx.integrationStore.get).mockResolvedValue({
        id: 'int-001',
        team_id: 'test-team',
        name: 'test',
        config_path: '/path',
        status: IntegrationStatus.Tested,
        error_message: '',
        created_at: Date.now(),
      });

      const result = await handler.handle(
        'activate_integration',
        { integration_id: 'int-001' },
        'aid-alice-001',
        'call-053',
      );

      expect(result.success).toBe(true);
      expect(result.result?.status).toBe(IntegrationStatus.Active);
    });
  });

  // -----------------------------------------------------------------------
  // Credential tools
  // -----------------------------------------------------------------------

  describe('get_credential', () => {
    it('returns credential value (file-based, no decryption)', async () => {
      const result = await handler.handle(
        'get_credential',
        { key: 'api-key' },
        'aid-alice-001',
        'call-060',
      );

      expect(result.success).toBe(true);
      expect(result.result?.value).toBe('encrypted:abc');
      // File-based credentials — no decryption call
      expect(ctx.keyManager.decrypt).not.toHaveBeenCalled();
    });

    it('returns NOT_FOUND for missing credential', async () => {
      vi.mocked(ctx.credentialStore.listByTeam).mockResolvedValue([]);

      const result = await handler.handle(
        'get_credential',
        { key: 'missing-key' },
        'aid-alice-001',
        'call-061',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });
  });

  describe('set_credential', () => {
    it('stores credential as plaintext (file-based, no encryption)', async () => {
      const result = await handler.handle(
        'set_credential',
        { key: 'secret', value: 'my-secret' },
        'aid-alice-001',
        'call-062',
      );

      expect(result.success).toBe(true);
      // File-based credentials — no encryption call
      expect(ctx.keyManager.encrypt).not.toHaveBeenCalled();
      expect(ctx.credentialStore.create).toHaveBeenCalledOnce();
      // Verify plaintext value is stored
      expect(ctx.credentialStore.create).toHaveBeenCalledWith(
        expect.objectContaining({ encrypted_value: 'my-secret' }),
      );
    });

    // Cross-team scope validation test removed — scope validation no longer enforced

    it('allows own-team scope (AC25/AC26)', async () => {
      // Explicitly passing scope matching the caller's team must succeed.
      const result = await handler.handle(
        'set_credential',
        { key: 'api-key', value: 'secret', scope: 'test-team' },
        'aid-alice-001',
        'call-064',
      );

      expect(result.success).toBe(true);
      expect(ctx.credentialStore.create).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------------------------------
  // Query tools
  // -----------------------------------------------------------------------

  describe('get_team', () => {
    it('returns team info from org chart', async () => {
      const result = await handler.handle(
        'get_team',
        { slug: 'test-team' },
        'aid-alice-001',
        'call-070',
      );

      expect(result.success).toBe(true);
      expect(result.result?.slug).toBe('test-team');
      expect(result.result?.tid).toBe('tid-test-001');
    });

    it('returns NOT_FOUND for unknown team', async () => {
      vi.mocked(ctx.orgChart.getTeamBySlug).mockReturnValue(undefined);

      const result = await handler.handle(
        'get_team',
        { slug: 'nonexistent' },
        'aid-alice-001',
        'call-071',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });
  });

  describe('get_task', () => {
    it('returns task info', async () => {
      const result = await handler.handle(
        'get_task',
        { task_id: 'task-001' },
        'aid-alice-001',
        'call-072',
      );

      expect(result.success).toBe(true);
      expect(result.result?.task_id).toBe('task-001');
      expect(result.result?.status).toBe(TaskStatus.Active);
    });
  });

  describe('get_health', () => {
    it('returns system-wide health without scope', async () => {
      const result = await handler.handle(
        'get_health',
        {},
        'aid-alice-001',
        'call-073',
      );

      expect(result.success).toBe(true);
      const entries = (result.result as Record<string, unknown>)['entries'] as unknown[];
      expect(entries.length).toBeGreaterThan(0);
    });
  });

  describe('inspect_topology', () => {
    it('returns topology tree', async () => {
      const result = await handler.handle(
        'inspect_topology',
        {},
        'aid-alice-001',
        'call-074',
      );

      expect(result.success).toBe(true);
      expect(result.result?.tree).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Team tools
  // -----------------------------------------------------------------------

  describe('create_team', () => {
    it('scaffolds workspace, adds to org chart, publishes event', async () => {
      const result = await handler.handle(
        'create_team',
        { slug: 'new-team', leader_aid: 'aid-alice-001', purpose: 'Testing' },
        'aid-alice-001',
        'call-080',
      );

      expect(result.success).toBe(true);
      expect(result.result?.slug).toBe('new-team');
      expect(ctx.provisioner.scaffoldWorkspace).toHaveBeenCalled();
      expect(ctx.orgChart.addTeam).toHaveBeenCalled();
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'team.created' }),
      );
    });

    it('rejects when depth exceeds max_depth (CON-01)', async () => {
      // Parent team is at depth 3, so new team would be depth 4 which exceeds max_depth=3
      vi.mocked(ctx.orgChart.getTeamBySlug).mockReturnValue(
        makeTeam({ depth: 3 }),
      );

      const result = await handler.handle(
        'create_team',
        { slug: 'deep-team', leader_aid: 'aid-alice-001', purpose: 'Too deep' },
        'aid-alice-001',
        'call-082',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.ValidationError);
      expect(result.error_message).toContain('exceeds maximum of 3');
      expect(ctx.logger.audit).toHaveBeenCalledWith(
        'security.limit_breach',
        expect.objectContaining({ type: 'max_depth', attempted: 4, limit: 3 }),
      );
      // Workspace must NOT be scaffolded when limit is breached
      expect(ctx.provisioner.scaffoldWorkspace).not.toHaveBeenCalled();
    });

    it('rejects when parent already has max_teams children (CON-02)', async () => {
      // Parent at depth 0, sibling count already at the limit (10)
      const fullSiblingList = Array.from({ length: 10 }, (_, i) =>
        makeTeam({ tid: `tid-child-00${i}`, slug: `child-${i}` }),
      );
      vi.mocked(ctx.orgChart.getChildren).mockReturnValue(fullSiblingList);

      const result = await handler.handle(
        'create_team',
        { slug: 'one-too-many', leader_aid: 'aid-alice-001', purpose: 'Overflow' },
        'aid-alice-001',
        'call-083',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.ValidationError);
      expect(result.error_message).toContain('already has 10 child teams (max: 10)');
      expect(ctx.logger.audit).toHaveBeenCalledWith(
        'security.limit_breach',
        expect.objectContaining({ type: 'max_teams', current: 10, limit: 10 }),
      );
      // Workspace must NOT be scaffolded when limit is breached
      expect(ctx.provisioner.scaffoldWorkspace).not.toHaveBeenCalled();
    });
  });

  describe('create_agent', () => {
    it('writes agent definition and registers in org chart', async () => {
      const result = await handler.handle(
        'create_agent',
        { name: 'bob', description: 'A helper', team_slug: 'test-team' },
        'aid-alice-001',
        'call-081',
      );

      expect(result.success).toBe(true);
      expect(result.result?.aid).toBeDefined();
      expect((result.result?.aid as string).startsWith('aid-')).toBe(true);
      expect(ctx.provisioner.writeAgentDefinition).toHaveBeenCalled();
      expect(ctx.orgChart.addAgent).toHaveBeenCalled();
    });

    it('rejects when team has max agents (CON-03)', async () => {
      // Team already has 5 agents (the default max_agents_per_team limit)
      const fullAgentList = Array.from({ length: 5 }, (_, i) =>
        makeAgent({ aid: `aid-member-00${i}`, name: `member-${i}` }),
      );
      vi.mocked(ctx.orgChart.getAgentsByTeam).mockReturnValue(fullAgentList);

      const result = await handler.handle(
        'create_agent',
        { name: 'overflow', description: 'One too many', team_slug: 'test-team' },
        'aid-alice-001',
        'call-082',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.ValidationError);
      expect(result.error_message).toContain("already has 5 agents (max: 5)");
      expect(ctx.logger.audit).toHaveBeenCalledWith(
        'security.limit_breach',
        expect.objectContaining({ type: 'max_agents_per_team', current: 5, limit: 5 }),
      );
      // Agent definition must NOT be written when limit is breached
      expect(ctx.provisioner.writeAgentDefinition).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Webhook
  // -----------------------------------------------------------------------

  describe('register_webhook', () => {
    it('publishes webhook.registered event and returns URL', async () => {
      const result = await handler.handle(
        'register_webhook',
        { path: 'deploy', target_team: 'ops-team' },
        'aid-alice-001',
        'call-090',
      );

      expect(result.success).toBe(true);
      expect(result.result?.webhook_url).toBe('/api/v1/hooks/deploy');
      expect(result.result?.registration_id).toBeDefined();
      expect(ctx.eventBus.publish).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'webhook.registered' }),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Error mapping
  // -----------------------------------------------------------------------

  describe('error mapping', () => {
    it('maps DomainError to appropriate WSErrorCode', async () => {
      vi.mocked(ctx.taskStore.get).mockRejectedValue(
        new (await import('../../domain/errors.js')).NotFoundError('Task not found'),
      );

      const result = await handler.handle(
        'get_task',
        { task_id: 'nonexistent' },
        'aid-alice-001',
        'call-100',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });

    it('maps non-DomainError to INTERNAL_ERROR', async () => {
      vi.mocked(ctx.taskStore.get).mockRejectedValue(new Error('DB exploded'));

      const result = await handler.handle(
        'get_task',
        { task_id: 'task-001' },
        'aid-alice-001',
        'call-101',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.InternalError);
    });
  });

  // -----------------------------------------------------------------------
  // Tool call logging
  // -----------------------------------------------------------------------

  describe('logging', () => {
    it('logs successful tool call to toolCallStore', async () => {
      await handler.handle(
        'list_containers',
        {},
        'aid-alice-001',
        'call-110',
      );

      expect(ctx.toolCallStore.create).toHaveBeenCalledOnce();
      const logged = vi.mocked(ctx.toolCallStore.create).mock.calls[0][0];
      expect(logged.tool_use_id).toBe('call-110');
      expect(logged.tool_name).toBe('list_containers');
      expect(logged.error).toBe('');
    });

    it('logs failed tool call with error message', async () => {
      vi.mocked(ctx.mcpRegistry.isAllowed).mockReturnValue(false);

      await handler.handle(
        'spawn_container',
        { team_slug: 'x' },
        'aid-bob-001',
        'call-111',
      );

      expect(ctx.toolCallStore.create).toHaveBeenCalledOnce();
      const logged = vi.mocked(ctx.toolCallStore.create).mock.calls[0][0];
      expect(logged.error).toContain('not authorized');
    });
  });

  // -----------------------------------------------------------------------
  // Validation
  // -----------------------------------------------------------------------

  describe('validation', () => {
    it('rejects missing required fields', async () => {
      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-alice-001' }, // missing 'prompt'
        'aid-alice-001',
        'call-120',
      );

      expect(result.success).toBe(false);
      // Zod validation failures map to INTERNAL_ERROR (not DomainError)
      expect(result.error_code).toBeDefined();
    });

    it('rejects unknown tool name', async () => {
      const result = await handler.handle(
        'nonexistent_tool',
        {},
        'aid-alice-001',
        'call-121',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.NotFound);
    });
  });
});

