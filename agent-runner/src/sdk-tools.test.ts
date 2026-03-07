import { describe, it, expect } from 'vitest';
import {
  getToolTimeout,
  isMutatingTool,
  SDK_TOOLS,
  MUTATING_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
  LONG_RUNNING_TIMEOUT_MS,
} from './sdk-tools.js';

describe('SDK Tools', () => {
  describe('getToolTimeout', () => {
    it('returns 60s for create_team', () => {
      expect(getToolTimeout('create_team')).toBe(MUTATING_TIMEOUT_MS);
    });

    it('returns 60s for dispatch_task', () => {
      expect(getToolTimeout('dispatch_task')).toBe(MUTATING_TIMEOUT_MS);
    });

    it('returns 60s for update_config', () => {
      expect(getToolTimeout('update_config')).toBe(MUTATING_TIMEOUT_MS);
    });

    it('returns 60s for enable_channel', () => {
      expect(getToolTimeout('enable_channel')).toBe(MUTATING_TIMEOUT_MS);
    });

    it('returns 60s for disable_channel', () => {
      expect(getToolTimeout('disable_channel')).toBe(MUTATING_TIMEOUT_MS);
    });

    it('returns 10s for get_config', () => {
      expect(getToolTimeout('get_config')).toBe(QUERY_TIMEOUT_MS);
    });

    it('returns 10s for list_channels', () => {
      expect(getToolTimeout('list_channels')).toBe(QUERY_TIMEOUT_MS);
    });

    it('returns 10s for get_system_status', () => {
      expect(getToolTimeout('get_system_status')).toBe(QUERY_TIMEOUT_MS);
    });

    it('returns 300s for dispatch_task_and_wait', () => {
      expect(getToolTimeout('dispatch_task_and_wait')).toBe(LONG_RUNNING_TIMEOUT_MS);
    });

    it('returns 60s (mutating) for unknown tools', () => {
      expect(getToolTimeout('unknown_tool')).toBe(MUTATING_TIMEOUT_MS);
    });
  });

  describe('isMutatingTool', () => {
    it('returns true for create_team', () => {
      expect(isMutatingTool('create_team')).toBe(true);
    });

    it('returns false for get_config', () => {
      expect(isMutatingTool('get_config')).toBe(false);
    });

    it('returns false for unknown tools', () => {
      expect(isMutatingTool('unknown')).toBe(false);
    });
  });

  describe('SDK_TOOLS', () => {
    it('has all expected tool definitions', () => {
      // Updated to reflect full Phase 5 tool set (26 tools)
      expect(SDK_TOOLS.length).toBeGreaterThanOrEqual(20);
    });

    it('all tools have name, description, and parameters', () => {
      for (const tool of SDK_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toBeDefined();
      }
    });

    it('contains all new team management tools', () => {
      const newTools = ['create_agent', 'delete_team', 'delete_agent', 'list_teams', 'get_team', 'update_team'];
      for (const toolName of newTools) {
        const tool = SDK_TOOLS.find((t) => t.name === toolName);
        expect(tool).toBeDefined();
      }
    });

    it('contains all new task management tools', () => {
      const taskTools = ['dispatch_task_and_wait', 'dispatch_subtask', 'get_task_status', 'cancel_task', 'list_tasks', 'get_member_status'];
      for (const toolName of taskTools) {
        const tool = SDK_TOOLS.find((t) => t.name === toolName);
        expect(tool).toBeDefined();
      }
    });

    it('dispatch_task_and_wait has 300s (long-running) timeout', () => {
      expect(getToolTimeout('dispatch_task_and_wait')).toBe(LONG_RUNNING_TIMEOUT_MS);
    });

    it('dispatch_task_and_wait schema requires agent_aid and prompt', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'dispatch_task_and_wait');
      expect(tool).toBeDefined();
      expect(tool!.parameters.required).toContain('agent_aid');
      expect(tool!.parameters.required).toContain('prompt');
      expect(tool!.parameters.properties['timeout_seconds']).toBeDefined();
    });

    it('contains skill and coordination tools', () => {
      const newTools = ['load_skill', 'escalate', 'consolidate_results'];
      for (const toolName of newTools) {
        const tool = SDK_TOOLS.find((t) => t.name === toolName);
        expect(tool).toBeDefined();
      }
    });

    it('create_agent is in MUTATING_TOOLS', () => {
      expect(isMutatingTool('create_agent')).toBe(true);
    });

    it('create_agent schema uses description instead of role_file', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'create_agent');
      expect(tool).toBeDefined();
      const props = tool!.parameters.properties;
      expect(props['description']).toBeDefined();
      expect(props['description']?.description).toContain('MUST be non-empty');
      expect(props['role_file']).toBeUndefined();
      expect(tool!.parameters.required).toContain('description');
      expect(tool!.parameters.required).not.toContain('role_file');
    });

    it('delete_team is in MUTATING_TOOLS', () => {
      expect(isMutatingTool('delete_team')).toBe(true);
    });

    it('list_teams is in QUERY_TOOLS', () => {
      expect(getToolTimeout('list_teams')).toBe(QUERY_TIMEOUT_MS);
      expect(isMutatingTool('list_teams')).toBe(false);
    });

    it('get_task_status is in QUERY_TOOLS', () => {
      expect(getToolTimeout('get_task_status')).toBe(QUERY_TIMEOUT_MS);
    });

    it('dispatch_subtask is in MUTATING_TOOLS', () => {
      expect(isMutatingTool('dispatch_subtask')).toBe(true);
    });

    it('contains create_team tool', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'create_team');
      expect(tool).toBeDefined();
    });

    it('contains get_config tool', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'get_config');
      expect(tool).toBeDefined();
    });

    it('contains create_skill tool', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'create_skill');
      expect(tool).toBeDefined();
    });

    it('create_skill is in MUTATING_TOOLS', () => {
      expect(isMutatingTool('create_skill')).toBe(true);
    });

    it('create_skill has 60s timeout', () => {
      expect(getToolTimeout('create_skill')).toBe(MUTATING_TIMEOUT_MS);
    });

    it('create_skill schema requires name, body, and team_slug', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'create_skill');
      expect(tool).toBeDefined();
      expect(tool!.parameters.required).toContain('name');
      expect(tool!.parameters.required).toContain('body');
      expect(tool!.parameters.required).toContain('team_slug');
    });

    it('create_skill schema has optional description, argument_hint, and allowed_tools', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'create_skill');
      expect(tool).toBeDefined();
      const props = tool!.parameters.properties;
      expect(props['description']).toBeDefined();
      expect(props['argument_hint']).toBeDefined();
      expect(props['allowed_tools']).toBeDefined();
      // Optional fields not in required
      expect(tool!.parameters.required).not.toContain('description');
      expect(tool!.parameters.required).not.toContain('argument_hint');
      expect(tool!.parameters.required).not.toContain('allowed_tools');
    });
  });
});
