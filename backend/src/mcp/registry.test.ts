/**
 * Tests for MCPRegistry implementation.
 *
 * Tests verify RBAC enforcement, fail-closed behavior, and CRUD operations.
 *
 * @module mcp/registry.test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MCPRegistryImpl, MAIN_ASSISTANT_TOOLS, TEAM_LEAD_TOOLS, MEMBER_TOOLS } from './registry.js';
import { ConflictError } from '../domain/errors.js';
import type { AgentRole } from '../domain/enums.js';

describe('MCPRegistryImpl', () => {
  let registry: MCPRegistryImpl;

  // Helper to create a mock handler for testing
  const mockHandler = async (args: Record<string, unknown>, agentAid: string) => {
    return { result: 'success', args, agentAid };
  };

  // Helper to create a test schema
  function createTestSchema(required: string[] = []) {
    return {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'Test parameter' },
      },
      required,
    };
  }

  beforeEach(() => {
    registry = new MCPRegistryImpl();
  });

  describe('CRUD operations', () => {
    it('registers a tool and retrieves it via getTool()', () => {
      const schema = createTestSchema(['name']);
      registry.registerTool('test_tool', schema, mockHandler);

      const result = registry.getTool('test_tool');

      expect(result).toBeDefined();
      expect(result?.schema).toEqual(schema);
      expect(result?.handler).toBe(mockHandler);
    });

    it('register duplicate tool name throws ConflictError', () => {
      const schema = createTestSchema(['name']);
      registry.registerTool('duplicate_tool', schema, mockHandler);

      expect(() => {
        registry.registerTool('duplicate_tool', schema, mockHandler);
      }).toThrow(ConflictError);
    });

    it('unregister removes tool (getTool returns undefined after)', () => {
      const schema = createTestSchema(['name']);
      registry.registerTool('to_remove', schema, mockHandler);

      expect(registry.getTool('to_remove')).toBeDefined();

      registry.unregisterTool('to_remove');

      expect(registry.getTool('to_remove')).toBeUndefined();
    });

    it('unregister is idempotent (no error on missing tool)', () => {
      // Should not throw even if tool doesn't exist
      expect(() => {
        registry.unregisterTool('non_existent_tool');
      }).not.toThrow();
    });

    it('listTools returns all registered tools with name + schema, no handler', () => {
      const schema1 = createTestSchema(['name']);
      const schema2 = createTestSchema([]);

      registry.registerTool('tool_one', schema1, mockHandler);
      registry.registerTool('tool_two', schema2, mockHandler);

      const tools = registry.listTools();

      expect(tools).toHaveLength(2);
      expect(tools).toContainEqual({ name: 'tool_one', schema: schema1 });
      expect(tools).toContainEqual({ name: 'tool_two', schema: schema2 });

      // Handler should NOT be included
      tools.forEach((tool) => {
        expect(tool).not.toHaveProperty('handler');
      });
    });

    it('getTool returns undefined for non-existent tool', () => {
      const result = registry.getTool('non_existent_tool');
      expect(result).toBeUndefined();
    });
  });

  describe('getToolsForRole', () => {
    it('getToolsForRole("main_assistant") returns intersection of registered tools and MAIN_ASSISTANT_TOOLS set', () => {
      // Register some tools that are in MAIN_ASSISTANT_TOOLS
      registry.registerTool('create_team', createTestSchema(), mockHandler);
      registry.registerTool('update_task_status', createTestSchema(), mockHandler);
      // Register a tool not in MAIN_ASSISTANT_TOOLS (none in our case, but test the intersection logic)
      registry.registerTool('unknown_tool', createTestSchema(), mockHandler);

      const tools = registry.getToolsForRole('main_assistant');

      // Should return only tools that are both registered AND in MAIN_ASSISTANT_TOOLS
      const toolNames = tools.map(t => t.name);
      expect(toolNames).toContain('create_team');
      expect(toolNames).toContain('update_task_status');
      expect(toolNames).not.toContain('unknown_tool');
    });

    it('getToolsForRole("team_lead") excludes container management tools', () => {
      // Register all container management tools plus some team tools
      registry.registerTool('spawn_container', createTestSchema(), mockHandler);
      registry.registerTool('stop_container', createTestSchema(), mockHandler);
      registry.registerTool('list_containers', createTestSchema(), mockHandler);
      registry.registerTool('create_team', createTestSchema(), mockHandler);
      registry.registerTool('update_task_status', createTestSchema(), mockHandler);

      const tools = registry.getToolsForRole('team_lead');
      const toolNames = tools.map(t => t.name);

      // Container tools should NOT be available to team_lead
      expect(toolNames).not.toContain('spawn_container');
      expect(toolNames).not.toContain('stop_container');
      expect(toolNames).not.toContain('list_containers');

      // But team tools should be available
      expect(toolNames).toContain('create_team');
      expect(toolNames).toContain('update_task_status');
    });

    it('getToolsForRole("member") returns only the 7 member-allowed tools', () => {
      // Register tools from different access levels
      registry.registerTool('spawn_container', createTestSchema(), mockHandler);
      registry.registerTool('create_team', createTestSchema(), mockHandler);
      registry.registerTool('update_task_status', createTestSchema(), mockHandler);
      registry.registerTool('send_message', createTestSchema(), mockHandler);
      registry.registerTool('escalate', createTestSchema(), mockHandler);
      registry.registerTool('save_memory', createTestSchema(), mockHandler);
      registry.registerTool('recall_memory', createTestSchema(), mockHandler);
      registry.registerTool('get_credential', createTestSchema(), mockHandler);
      registry.registerTool('get_task', createTestSchema(), mockHandler);

      const tools = registry.getToolsForRole('member');
      const toolNames = tools.map(t => t.name);

      // Should return only member-allowed tools (7 total)
      expect(toolNames).toContain('update_task_status');
      expect(toolNames).toContain('send_message');
      expect(toolNames).toContain('escalate');
      expect(toolNames).toContain('save_memory');
      expect(toolNames).toContain('recall_memory');
      expect(toolNames).toContain('get_credential');
      expect(toolNames).toContain('get_task');

      // Should NOT contain higher-privilege tools
      expect(toolNames).not.toContain('spawn_container');
      expect(toolNames).not.toContain('create_team');

      // Should have exactly 7 tools
      expect(tools.length).toBe(7);
    });

    it('getToolsForRole returns empty array when no tools are registered', () => {
      const tools = registry.getToolsForRole('main_assistant');
      expect(tools).toEqual([]);
    });

    it('getToolsForRole with unknown role returns empty array (fail-closed)', () => {
      registry.registerTool('some_tool', createTestSchema(), mockHandler);

      // TypeScript would prevent passing an invalid role at compile time,
      // but we test the behavior at runtime for completeness
      const tools = registry.getToolsForRole('unknown_role' as AgentRole);
      expect(tools).toEqual([]);
    });
  });

  describe('isAllowed', () => {
    it('isAllowed("spawn_container", "main_assistant") returns true', () => {
      const result = registry.isAllowed('spawn_container', 'main_assistant');
      expect(result).toBe(true);
    });

    it('isAllowed("spawn_container", "team_lead") returns false', () => {
      const result = registry.isAllowed('spawn_container', 'team_lead');
      expect(result).toBe(false);
    });

    it('isAllowed("spawn_container", "member") returns false', () => {
      const result = registry.isAllowed('spawn_container', 'member');
      expect(result).toBe(false);
    });

    it('isAllowed("update_task_status", "member") returns true', () => {
      const result = registry.isAllowed('update_task_status', 'member');
      expect(result).toBe(true);
    });

    it('isAllowed returns false for unknown tool name (fail-closed)', () => {
      const result = registry.isAllowed('completely_unknown_tool', 'main_assistant');
      expect(result).toBe(false);
    });

    it('isAllowed returns false for unknown role (fail-closed)', () => {
      const result = registry.isAllowed('update_task_status', 'invalid_role' as AgentRole);
      expect(result).toBe(false);
    });
  });

  describe('role tool matrix integrity', () => {
    it('MAIN_ASSISTANT_TOOLS contains all 23 tools', () => {
      // Verify the set size matches documented count
      expect(MAIN_ASSISTANT_TOOLS.size).toBe(23);
    });

    it('TEAM_LEAD_TOOLS excludes container tools (20 tools)', () => {
      // 23 - 3 container tools = 20
      expect(TEAM_LEAD_TOOLS.size).toBe(20);

      // Verify container tools are excluded
      expect(TEAM_LEAD_TOOLS.has('spawn_container')).toBe(false);
      expect(TEAM_LEAD_TOOLS.has('stop_container')).toBe(false);
      expect(TEAM_LEAD_TOOLS.has('list_containers')).toBe(false);
    });

    it('MEMBER_TOOLS contains exactly 7 tools', () => {
      expect(MEMBER_TOOLS.size).toBe(7);

      // Verify expected member tools
      expect(MEMBER_TOOLS.has('update_task_status')).toBe(true);
      expect(MEMBER_TOOLS.has('send_message')).toBe(true);
      expect(MEMBER_TOOLS.has('escalate')).toBe(true);
      expect(MEMBER_TOOLS.has('save_memory')).toBe(true);
      expect(MEMBER_TOOLS.has('recall_memory')).toBe(true);
      expect(MEMBER_TOOLS.has('get_credential')).toBe(true);
      expect(MEMBER_TOOLS.has('get_task')).toBe(true);
    });
  });
});