/**
 * Tests for admin SDK tool handlers (tools-admin.ts)
 *
 * Covers:
 *   1. get_config returns correct config section
 *   2. get_config with empty section returns full config (redacted)
 *   3. get_config with unknown section returns error
 *   4. update_config modifies and saves a system field
 *   5. update_config modifies and saves a channel field
 *   6. update_config with unsupported section returns error
 *   7. update_config with unsupported field returns error
 *   8. update_config with wrong value type returns error
 *   9. get_system_status returns uptime and connected teams
 *   10. list_channels returns connected teams
 *   11. enable_channel enables and saves the config
 *   12. enable_channel with unknown channel returns error
 *   13. disable_channel disables and saves the config
 *   14. disable_channel with unknown channel returns error
 *   15. Token redaction in channels section
 *   16. registerAdminTools registers all expected tool names
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerAdminTools, type AdminToolsDeps } from './tools-admin.js';
import { ToolHandler } from './toolhandler.js';
import { ValidationError } from '../domain/errors.js';
import type { ConfigLoader, KeyManager, WSHub } from '../domain/interfaces.js';
import type { MasterConfig, JsonValue } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMasterConfig(): MasterConfig {
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
    channels: {
      discord: { enabled: true, token: 'discord-secret', channel_id: '123' },
      whatsapp: { enabled: false, token: 'wa-secret' },
    },
  };
}

function makeMockConfigLoader(cfg: MasterConfig): ConfigLoader {
  return {
    loadMaster: vi.fn().mockResolvedValue(cfg),
    saveMaster: vi.fn().mockResolvedValue(undefined),
    getMaster: vi.fn().mockReturnValue(cfg),
    loadProviders: vi.fn(),
    saveProviders: vi.fn(),
    loadTeam: vi.fn(),
    saveTeam: vi.fn(),
    createTeamDir: vi.fn(),
    deleteTeamDir: vi.fn(),
    listTeams: vi.fn(),
    watchMaster: vi.fn(),
    watchProviders: vi.fn(),
    watchTeam: vi.fn(),
    stopWatching: vi.fn(),
  };
}

function makeMockWSHub(teams: string[] = []): WSHub {
  return {
    registerConnection: vi.fn(),
    unregisterConnection: vi.fn(),
    sendToTeam: vi.fn(),
    broadcastAll: vi.fn(),
    generateToken: vi.fn(),
    getUpgradeHandler: vi.fn(),
    getConnectedTeams: vi.fn().mockReturnValue(teams),
    setOnMessage: vi.fn(),
    setOnConnect: vi.fn(),
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

let cfg: MasterConfig;
let configLoader: ConfigLoader;
let wsHub: WSHub;
let keyManager: KeyManager;
let deps: AdminToolsDeps;
let handler: ToolHandler;
const START_TIME = new Date('2026-01-01T00:00:00Z');

beforeEach(() => {
  cfg = makeMasterConfig();
  configLoader = makeMockConfigLoader(cfg);
  wsHub = makeMockWSHub(['tid-aaa-001', 'tid-bbb-002']);
  keyManager = makeMockKeyManager();
  deps = { configLoader, keyManager, wsHub, startTime: START_TIME };
  handler = new ToolHandler(makeLogger());
  registerAdminTools(handler, deps);
});

// ---------------------------------------------------------------------------
// registerAdminTools
// ---------------------------------------------------------------------------

describe('registerAdminTools', () => {
  it('registers all expected tool names', () => {
    const tools = handler.registeredTools();
    expect(tools).toContain('get_config');
    expect(tools).toContain('update_config');
    expect(tools).toContain('get_system_status');
    expect(tools).toContain('list_channels');
    expect(tools).toContain('enable_channel');
    expect(tools).toContain('disable_channel');
  });
});

// ---------------------------------------------------------------------------
// get_config
// ---------------------------------------------------------------------------

describe('get_config', () => {
  it('returns system section', async () => {
    const result = await handler.handleToolCall('call-1', 'get_config', { section: 'system' });
    expect(result).toEqual(cfg.system);
  });

  it('returns assistant section', async () => {
    const result = await handler.handleToolCall('call-2', 'get_config', { section: 'assistant' });
    expect(result).toEqual(cfg.assistant);
  });

  it('returns channels section with tokens redacted', async () => {
    const result = await handler.handleToolCall('call-3', 'get_config', { section: 'channels' }) as Record<string, JsonValue>;
    expect(result).toBeDefined();
    const discord = result['discord'] as Record<string, JsonValue>;
    const whatsapp = result['whatsapp'] as Record<string, JsonValue>;
    expect(discord['token']).toBe('[REDACTED]');
    expect(whatsapp['token']).toBe('[REDACTED]');
    // Non-sensitive fields are preserved
    expect(discord['enabled']).toBe(true);
    expect(discord['channel_id']).toBe('123');
  });

  it('returns full config with tokens redacted when section is empty string', async () => {
    const result = await handler.handleToolCall('call-4', 'get_config', { section: '' }) as Record<string, JsonValue>;
    expect(result).toBeDefined();
    const channels = result['channels'] as Record<string, JsonValue>;
    const discord = channels['discord'] as Record<string, JsonValue>;
    const whatsapp = channels['whatsapp'] as Record<string, JsonValue>;
    expect(discord['token']).toBe('[REDACTED]');
    expect(whatsapp['token']).toBe('[REDACTED]');
    // System section is included
    const system = result['system'] as Record<string, JsonValue>;
    expect(system['listen_address']).toBe(':8080');
  });

  it('returns full config when section arg is omitted', async () => {
    // Omitting section entirely — args has no 'section' key
    const result = await handler.handleToolCall('call-5', 'get_config', {}) as Record<string, JsonValue>;
    expect(result).toBeDefined();
    // Should include all top-level keys
    expect(result['system']).toBeDefined();
    expect(result['assistant']).toBeDefined();
    expect(result['channels']).toBeDefined();
  });

  it('throws ValidationError for unknown section', async () => {
    await expect(
      handler.handleToolCall('call-6', 'get_config', { section: 'providers' }),
    ).rejects.toThrow(ValidationError);

    await expect(
      handler.handleToolCall('call-7', 'get_config', { section: 'providers' }),
    ).rejects.toThrow('unknown section: providers');
  });

  it('does not mutate the original config tokens when redacting', async () => {
    await handler.handleToolCall('call-8', 'get_config', { section: 'channels' });
    // The mock config object should be unchanged — redaction is a copy
    expect(cfg.channels.discord.token).toBe('discord-secret');
    expect(cfg.channels.whatsapp.token).toBe('wa-secret');
  });

  it('does not redact missing tokens', async () => {
    // Remove tokens from config
    cfg.channels.discord.token = undefined;
    cfg.channels.whatsapp.token = undefined;

    const result = await handler.handleToolCall('call-9', 'get_config', { section: 'channels' }) as Record<string, JsonValue>;
    const discord = result['discord'] as Record<string, JsonValue>;
    const whatsapp = result['whatsapp'] as Record<string, JsonValue>;
    // undefined stays undefined (or absent from JSON)
    expect(discord['token']).toBeUndefined();
    expect(whatsapp['token']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// update_config
// ---------------------------------------------------------------------------

describe('update_config', () => {
  it('updates system.log_level and saves', async () => {
    const result = await handler.handleToolCall('call-10', 'update_config', {
      section: 'system',
      field: 'log_level',
      value: 'debug',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('updated');
    expect(cfg.system.log_level).toBe('debug');
    expect(configLoader.saveMaster).toHaveBeenCalledWith(cfg);
  });

  it('updates system.listen_address and saves', async () => {
    const result = await handler.handleToolCall('call-11', 'update_config', {
      section: 'system',
      field: 'listen_address',
      value: ':9090',
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('updated');
    expect(cfg.system.listen_address).toBe(':9090');
    expect(configLoader.saveMaster).toHaveBeenCalledWith(cfg);
  });

  it('updates channels.discord.enabled and saves', async () => {
    const result = await handler.handleToolCall('call-12', 'update_config', {
      section: 'channels',
      field: 'discord.enabled',
      value: false,
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('updated');
    expect(cfg.channels.discord.enabled).toBe(false);
    expect(configLoader.saveMaster).toHaveBeenCalledWith(cfg);
  });

  it('updates channels.whatsapp.enabled and saves', async () => {
    const result = await handler.handleToolCall('call-13', 'update_config', {
      section: 'channels',
      field: 'whatsapp.enabled',
      value: true,
    }) as Record<string, JsonValue>;

    expect(result['status']).toBe('updated');
    expect(cfg.channels.whatsapp.enabled).toBe(true);
    expect(configLoader.saveMaster).toHaveBeenCalledWith(cfg);
  });

  it('throws ValidationError for missing section', async () => {
    await expect(
      handler.handleToolCall('call-14', 'update_config', { field: 'log_level', value: 'debug' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for missing field', async () => {
    await expect(
      handler.handleToolCall('call-15', 'update_config', { section: 'system', value: 'debug' }),
    ).rejects.toThrow(ValidationError);
  });

  it('throws ValidationError for unsupported section', async () => {
    await expect(
      handler.handleToolCall('call-16', 'update_config', {
        section: 'assistant',
        field: 'name',
        value: 'NewName',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('call-17', 'update_config', {
        section: 'assistant',
        field: 'name',
        value: 'NewName',
      }),
    ).rejects.toThrow('unsupported section for update: assistant');
  });

  it('throws ValidationError for unsupported system field', async () => {
    await expect(
      handler.handleToolCall('call-18', 'update_config', {
        section: 'system',
        field: 'unknown_field',
        value: 'x',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('call-19', 'update_config', {
        section: 'system',
        field: 'unknown_field',
        value: 'x',
      }),
    ).rejects.toThrow('unsupported system field: unknown_field');
  });

  it('throws ValidationError for unsupported channel field', async () => {
    await expect(
      handler.handleToolCall('call-20', 'update_config', {
        section: 'channels',
        field: 'discord.token',
        value: 'new-token',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('call-21', 'update_config', {
        section: 'channels',
        field: 'discord.token',
        value: 'new-token',
      }),
    ).rejects.toThrow('unsupported channel field: discord.token');
  });

  it('throws ValidationError when log_level value is not a string', async () => {
    await expect(
      handler.handleToolCall('call-22', 'update_config', {
        section: 'system',
        field: 'log_level',
        value: 42,
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('call-23', 'update_config', {
        section: 'system',
        field: 'log_level',
        value: 42,
      }),
    ).rejects.toThrow('log_level must be a string');
  });

  it('throws ValidationError when discord.enabled value is not a boolean', async () => {
    await expect(
      handler.handleToolCall('call-24', 'update_config', {
        section: 'channels',
        field: 'discord.enabled',
        value: 'yes',
      }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('call-25', 'update_config', {
        section: 'channels',
        field: 'discord.enabled',
        value: 'yes',
      }),
    ).rejects.toThrow('discord.enabled must be a boolean');
  });
});

// ---------------------------------------------------------------------------
// get_system_status
// ---------------------------------------------------------------------------

describe('get_system_status', () => {
  it('returns connected teams list', async () => {
    const result = await handler.handleToolCall('call-30', 'get_system_status', {}) as Record<string, JsonValue>;
    const teams = result['connected_teams'] as string[];
    expect(teams).toEqual(['tid-aaa-001', 'tid-bbb-002']);
  });

  it('returns version string', async () => {
    const result = await handler.handleToolCall('call-31', 'get_system_status', {}) as Record<string, JsonValue>;
    expect(result['version']).toBe('0.1.0');
  });

  it('returns an uptime string', async () => {
    const result = await handler.handleToolCall('call-32', 'get_system_status', {}) as Record<string, JsonValue>;
    const uptime = result['uptime'];
    expect(typeof uptime).toBe('string');
    // Must end with 's' (seconds always included)
    expect((uptime as string).endsWith('s')).toBe(true);
  });

  it('returns empty connected_teams when no containers are connected', async () => {
    const emptyHub = makeMockWSHub([]);
    const localDeps: AdminToolsDeps = { ...deps, wsHub: emptyHub };
    const localHandler = new ToolHandler(makeLogger());
    registerAdminTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('call-33', 'get_system_status', {}) as Record<string, JsonValue>;
    expect(result['connected_teams']).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// list_channels
// ---------------------------------------------------------------------------

describe('list_channels', () => {
  it('returns connected teams', async () => {
    const result = await handler.handleToolCall('call-40', 'list_channels', {}) as Record<string, JsonValue>;
    const teams = result['connected_teams'] as string[];
    expect(teams).toEqual(['tid-aaa-001', 'tid-bbb-002']);
  });

  it('returns empty array when no teams connected', async () => {
    const emptyHub = makeMockWSHub([]);
    const localDeps: AdminToolsDeps = { ...deps, wsHub: emptyHub };
    const localHandler = new ToolHandler(makeLogger());
    registerAdminTools(localHandler, localDeps);

    const result = await localHandler.handleToolCall('call-41', 'list_channels', {}) as Record<string, JsonValue>;
    expect(result['connected_teams']).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// enable_channel
// ---------------------------------------------------------------------------

describe('enable_channel', () => {
  it('enables discord and saves', async () => {
    cfg.channels.discord.enabled = false;
    const result = await handler.handleToolCall('call-50', 'enable_channel', { channel: 'discord' }) as Record<string, JsonValue>;

    expect(result['status']).toBe('enabled');
    expect(result['channel']).toBe('discord');
    expect(cfg.channels.discord.enabled).toBe(true);
    expect(configLoader.saveMaster).toHaveBeenCalledWith(cfg);
  });

  it('enables whatsapp and saves', async () => {
    cfg.channels.whatsapp.enabled = false;
    const result = await handler.handleToolCall('call-51', 'enable_channel', { channel: 'whatsapp' }) as Record<string, JsonValue>;

    expect(result['status']).toBe('enabled');
    expect(result['channel']).toBe('whatsapp');
    expect(cfg.channels.whatsapp.enabled).toBe(true);
    expect(configLoader.saveMaster).toHaveBeenCalledWith(cfg);
  });

  it('throws ValidationError for unknown channel', async () => {
    await expect(
      handler.handleToolCall('call-52', 'enable_channel', { channel: 'telegram' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('call-53', 'enable_channel', { channel: 'telegram' }),
    ).rejects.toThrow('unknown channel: telegram');
  });

  it('throws ValidationError for missing channel arg', async () => {
    await expect(
      handler.handleToolCall('call-54', 'enable_channel', {}),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('call-55', 'enable_channel', {}),
    ).rejects.toThrow('channel name is required');
  });

  it('throws ValidationError for empty channel string', async () => {
    await expect(
      handler.handleToolCall('call-56', 'enable_channel', { channel: '' }),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// disable_channel
// ---------------------------------------------------------------------------

describe('disable_channel', () => {
  it('disables discord and saves', async () => {
    cfg.channels.discord.enabled = true;
    const result = await handler.handleToolCall('call-60', 'disable_channel', { channel: 'discord' }) as Record<string, JsonValue>;

    expect(result['status']).toBe('disabled');
    expect(result['channel']).toBe('discord');
    expect(cfg.channels.discord.enabled).toBe(false);
    expect(configLoader.saveMaster).toHaveBeenCalledWith(cfg);
  });

  it('disables whatsapp and saves', async () => {
    cfg.channels.whatsapp.enabled = true;
    const result = await handler.handleToolCall('call-61', 'disable_channel', { channel: 'whatsapp' }) as Record<string, JsonValue>;

    expect(result['status']).toBe('disabled');
    expect(result['channel']).toBe('whatsapp');
    expect(cfg.channels.whatsapp.enabled).toBe(false);
    expect(configLoader.saveMaster).toHaveBeenCalledWith(cfg);
  });

  it('throws ValidationError for unknown channel', async () => {
    await expect(
      handler.handleToolCall('call-62', 'disable_channel', { channel: 'slack' }),
    ).rejects.toThrow(ValidationError);
    await expect(
      handler.handleToolCall('call-63', 'disable_channel', { channel: 'slack' }),
    ).rejects.toThrow('unknown channel: slack');
  });

  it('throws ValidationError for missing channel arg', async () => {
    await expect(
      handler.handleToolCall('call-64', 'disable_channel', {}),
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// Token redaction edge cases
// ---------------------------------------------------------------------------

describe('token redaction', () => {
  it('redacts non-empty discord token in full config return', async () => {
    const result = await handler.handleToolCall('call-70', 'get_config', { section: '' }) as Record<string, JsonValue>;
    const channels = result['channels'] as Record<string, JsonValue>;
    const discord = channels['discord'] as Record<string, JsonValue>;
    expect(discord['token']).toBe('[REDACTED]');
  });

  it('redacts non-empty whatsapp token in channels section', async () => {
    const result = await handler.handleToolCall('call-71', 'get_config', { section: 'channels' }) as Record<string, JsonValue>;
    const whatsapp = result['whatsapp'] as Record<string, JsonValue>;
    expect(whatsapp['token']).toBe('[REDACTED]');
  });

  it('does not redact empty string token', async () => {
    cfg.channels.discord.token = '';
    const result = await handler.handleToolCall('call-72', 'get_config', { section: 'channels' }) as Record<string, JsonValue>;
    const discord = result['discord'] as Record<string, JsonValue>;
    // Empty string token stays as empty string (not redacted)
    expect(discord['token']).toBe('');
  });
});
