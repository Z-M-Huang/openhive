import { describe, it, expect } from 'vitest';
import {
  getToolTimeout,
  isMutatingTool,
  SDK_TOOLS,
  MUTATING_TIMEOUT_MS,
  QUERY_TIMEOUT_MS,
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
    it('has 8 tool definitions', () => {
      expect(SDK_TOOLS).toHaveLength(8);
    });

    it('all tools have name, description, and parameters', () => {
      for (const tool of SDK_TOOLS) {
        expect(tool.name).toBeTruthy();
        expect(tool.description).toBeTruthy();
        expect(tool.parameters).toBeDefined();
      }
    });

    it('contains create_team tool', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'create_team');
      expect(tool).toBeDefined();
    });

    it('contains get_config tool', () => {
      const tool = SDK_TOOLS.find((t) => t.name === 'get_config');
      expect(tool).toBeDefined();
    });
  });
});
