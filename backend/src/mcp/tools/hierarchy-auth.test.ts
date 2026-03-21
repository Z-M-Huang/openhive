/**
 * Tests for SDKToolHandler hierarchy authorization (AC-L6-04).
 *
 * @module mcp/tools/hierarchy-auth.test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SDKToolHandler, createToolHandlers } from './index.js';
import type { ToolContext } from './index.js';
import { TaskStatus, WSErrorCode } from '../../domain/index.js';
import { createMockContext, makeTask } from './__test-helpers.js';

describe('SDKToolHandler hierarchy authorization', () => {
  let ctx: ToolContext;
  let handler: SDKToolHandler;

  beforeEach(() => {
    ctx = createMockContext();
    handler = new SDKToolHandler(ctx, createToolHandlers(ctx));
  });

  describe('create_task with hierarchy check', () => {
    it('allows when authorized for target agent', async () => {
      vi.mocked(ctx.orgChart.isAuthorized).mockReturnValue(true);

      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-bob-002', prompt: 'Do work' },
        'aid-alice-001',
        'call-h1',
      );

      expect(result.success).toBe(true);
      expect(ctx.orgChart.isAuthorized).toHaveBeenCalledWith('aid-alice-001', 'aid-bob-002');
    });

    it('rejects when not authorized for target agent', async () => {
      vi.mocked(ctx.orgChart.isAuthorized).mockReturnValue(false);

      const result = await handler.handle(
        'create_task',
        { agent_aid: 'aid-charlie-003', prompt: 'Do work' },
        'aid-alice-001',
        'call-h2',
      );

      expect(result.success).toBe(false);
      expect(result.error_code).toBe(WSErrorCode.AccessDenied);
      expect(result.error_message).toContain('not authorized');
    });
  });

  describe('send_message with hierarchy check', () => {
    it('checks authorization for target_aid', async () => {
      vi.mocked(ctx.orgChart.isAuthorized).mockReturnValue(true);

      await handler.handle(
        'send_message',
        { target_aid: 'aid-bob-002', content: 'Hello' },
        'aid-alice-001',
        'call-h3',
      );

      expect(ctx.orgChart.isAuthorized).toHaveBeenCalledWith('aid-alice-001', 'aid-bob-002');
    });
  });

  describe('escalate with hierarchy check', () => {
    it('checks authorization for target_aid', async () => {
      vi.mocked(ctx.taskStore.get).mockResolvedValue(makeTask({ status: TaskStatus.Active }));
      vi.mocked(ctx.orgChart.isAuthorized).mockReturnValue(true);

      await handler.handle(
        'escalate',
        { task_id: 'task-001', target_aid: 'aid-lead-002', reason: 'need_guidance', context: {} },
        'aid-member-003',
        'call-h4',
      );

      expect(ctx.orgChart.isAuthorized).toHaveBeenCalledWith('aid-member-003', 'aid-lead-002');
    });
  });
});

