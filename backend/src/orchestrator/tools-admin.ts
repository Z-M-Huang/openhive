/**
 * OpenHive Backend - Admin SDK Tool Handlers
 *
 * Registers admin tool handlers on the ToolHandler for use by the main
 * assistant. Handlers cover config read/write, system status, and channel
 * enable/disable.
 */

import type { ConfigLoader, KeyManager, WSHub } from '../domain/interfaces.js';
import type { JsonValue, MasterConfig } from '../domain/types.js';
import { AccessDeniedError, ValidationError } from '../domain/errors.js';
import type { ToolFunc, ToolCallContext } from './toolhandler.js';
import type { ToolRegistry } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// AdminToolsDeps
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into admin tool handlers.
 */
export interface AdminToolsDeps {
  configLoader: ConfigLoader;
  keyManager: KeyManager;
  wsHub: WSHub;
  startTime: Date;
}

// ---------------------------------------------------------------------------
// registerAdminTools
// ---------------------------------------------------------------------------

/**
 * Registers all admin SDK custom tool handlers on the ToolHandler.
 */
export function registerAdminTools(handler: ToolRegistry, deps: AdminToolsDeps): void {
  handler.register('get_config', withAdminGuard('get_config', makeGetConfig(deps.configLoader)));
  handler.register('update_config', withAdminGuard('update_config', makeUpdateConfig(deps.configLoader)));
  handler.register('get_system_status', withAdminGuard('get_system_status', makeGetSystemStatus(deps)));
  handler.register('list_channels', withAdminGuard('list_channels', makeListChannels(deps.wsHub)));
  handler.register('enable_channel', withAdminGuard('enable_channel', makeEnableChannel(deps.configLoader)));
  handler.register('disable_channel', withAdminGuard('disable_channel', makeDisableChannel(deps.configLoader)));
}

// ---------------------------------------------------------------------------
// Admin guard
// ---------------------------------------------------------------------------

/**
 * Asserts that the tool call originates from the main team context.
 * Admin tools must only be callable by the main assistant.
 * Throws AccessDeniedError if context is missing or teamSlug is not 'main'.
 */
function assertAdminContext(context: ToolCallContext | undefined, toolName: string): void {
  if (context === undefined || context.teamSlug !== 'main') {
    throw new AccessDeniedError(
      'tool',
      `${toolName} is restricted to the main assistant`,
    );
  }
}

/**
 * Wraps a ToolFunc with an admin guard that requires main team context.
 */
function withAdminGuard(toolName: string, fn: ToolFunc): ToolFunc {
  return async (args: Record<string, JsonValue>, context?: ToolCallContext): Promise<JsonValue> => {
    assertAdminContext(context, toolName);
    return fn(args, context);
  };
}

// ---------------------------------------------------------------------------
// Uptime formatting
// ---------------------------------------------------------------------------

/**
 * Formats a duration in milliseconds as a human-readable string.
 * Examples: "45s", "2m 15s", "1h 3m 7s"
 */
function formatUptime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// Redaction helpers
// ---------------------------------------------------------------------------

/**
 * Returns a deep copy of ChannelsConfig with sensitive token fields redacted.
 */
function redactChannels(channels: MasterConfig['channels']): MasterConfig['channels'] {
  return {
    discord: {
      ...channels.discord,
      token: channels.discord.token !== undefined && channels.discord.token !== ''
        ? '[REDACTED]'
        : channels.discord.token,
    },
    whatsapp: {
      ...channels.whatsapp,
      token: channels.whatsapp.token !== undefined && channels.whatsapp.token !== ''
        ? '[REDACTED]'
        : channels.whatsapp.token,
    },
  };
}

// ---------------------------------------------------------------------------
// get_config
// ---------------------------------------------------------------------------

/**
 * Returns a config section (or the full config) from the ConfigLoader.
 * Sensitive token fields are redacted when channels or full config is returned.
 *
 * Args:
 *   section?: string — "system" | "assistant" | "channels" | "" (full config)
 */
function makeGetConfig(configLoader: ConfigLoader): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const section = args['section'] !== undefined ? args['section'] : '';

    if (typeof section !== 'string') {
      throw new ValidationError('section', 'section must be a string');
    }

    const cfg = await configLoader.loadMaster();

    switch (section) {
      case 'system':
        return cfg.system as unknown as JsonValue;

      case 'assistant':
        return cfg.assistant as unknown as JsonValue;

      case 'channels': {
        const redacted = redactChannels(cfg.channels);
        return redacted as unknown as JsonValue;
      }

      case '': {
        // Return full config with channels redacted.
        const redactedFull: MasterConfig = {
          ...cfg,
          channels: redactChannels(cfg.channels),
        };
        return redactedFull as unknown as JsonValue;
      }

      default:
        throw new ValidationError('section', `unknown section: ${section}`);
    }
  };
}

// ---------------------------------------------------------------------------
// update_config
// ---------------------------------------------------------------------------

/**
 * Updates a config field identified by section + field path, then saves.
 *
 * Args:
 *   section: string — "system" | "channels"
 *   field:   string — field path within that section
 *   value:   JsonValue — new value (string or boolean depending on field)
 */
function makeUpdateConfig(configLoader: ConfigLoader): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const section = args['section'];
    const field = args['field'];
    const value = args['value'];

    if (typeof section !== 'string' || section === '') {
      throw new ValidationError('section', 'section is required');
    }
    if (typeof field !== 'string' || field === '') {
      throw new ValidationError('field', 'field is required');
    }
    if (value === undefined || value === null) {
      throw new ValidationError('value', 'value is required');
    }

    const cfg = await configLoader.loadMaster();

    switch (section) {
      case 'system':
        applySystemUpdate(cfg, field, value);
        break;
      case 'channels':
        applyChannelUpdate(cfg, field, value);
        break;
      default:
        throw new ValidationError('section', `unsupported section for update: ${section}`);
    }

    await configLoader.saveMaster(cfg);

    return { status: 'updated' };
  };
}

/**
 * Applies a field update to the system config section.
 */
function applySystemUpdate(cfg: MasterConfig, field: string, value: JsonValue): void {
  switch (field) {
    case 'log_level':
      if (typeof value !== 'string') {
        throw new ValidationError('value', 'log_level must be a string');
      }
      cfg.system.log_level = value;
      break;

    case 'listen_address':
      if (typeof value !== 'string') {
        throw new ValidationError('value', 'listen_address must be a string');
      }
      cfg.system.listen_address = value;
      break;

    default:
      throw new ValidationError('field', `unsupported system field: ${field}`);
  }
}

/**
 * Applies a field update to the channels config section.
 */
function applyChannelUpdate(cfg: MasterConfig, field: string, value: JsonValue): void {
  switch (field) {
    case 'discord.enabled':
      if (typeof value !== 'boolean') {
        throw new ValidationError('value', 'discord.enabled must be a boolean');
      }
      cfg.channels.discord.enabled = value;
      break;

    case 'whatsapp.enabled':
      if (typeof value !== 'boolean') {
        throw new ValidationError('value', 'whatsapp.enabled must be a boolean');
      }
      cfg.channels.whatsapp.enabled = value;
      break;

    default:
      throw new ValidationError('field', `unsupported channel field: ${field}`);
  }
}

// ---------------------------------------------------------------------------
// get_system_status
// ---------------------------------------------------------------------------

/**
 * Returns current system status: connected teams, uptime, version.
 */
function makeGetSystemStatus(deps: AdminToolsDeps): ToolFunc {
  return async (_args: Record<string, JsonValue>): Promise<JsonValue> => {
    const teams = deps.wsHub.getConnectedTeams();
    const uptimeMs = Date.now() - deps.startTime.getTime();

    return {
      connected_teams: teams,
      uptime: formatUptime(uptimeMs),
      version: '0.1.0',
    };
  };
}

// ---------------------------------------------------------------------------
// list_channels
// ---------------------------------------------------------------------------

/**
 * Returns the list of currently connected team IDs.
 */
function makeListChannels(wsHub: WSHub): ToolFunc {
  return async (_args: Record<string, JsonValue>): Promise<JsonValue> => {
    const teams = wsHub.getConnectedTeams();
    return { connected_teams: teams };
  };
}

// ---------------------------------------------------------------------------
// enable_channel / disable_channel
// ---------------------------------------------------------------------------

/**
 * Enables a named messaging channel in the config, then saves.
 */
function makeEnableChannel(configLoader: ConfigLoader): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const channel = args['channel'];
    if (typeof channel !== 'string' || channel === '') {
      throw new ValidationError('channel', 'channel name is required');
    }

    const cfg = await configLoader.loadMaster();

    switch (channel) {
      case 'discord':
        cfg.channels.discord.enabled = true;
        break;
      case 'whatsapp':
        cfg.channels.whatsapp.enabled = true;
        break;
      default:
        throw new ValidationError('channel', `unknown channel: ${channel}`);
    }

    await configLoader.saveMaster(cfg);
    return { status: 'enabled', channel };
  };
}

/**
 * Disables a named messaging channel in the config, then saves.
 */
function makeDisableChannel(configLoader: ConfigLoader): ToolFunc {
  return async (args: Record<string, JsonValue>): Promise<JsonValue> => {
    const channel = args['channel'];
    if (typeof channel !== 'string' || channel === '') {
      throw new ValidationError('channel', 'channel name is required');
    }

    const cfg = await configLoader.loadMaster();

    switch (channel) {
      case 'discord':
        cfg.channels.discord.enabled = false;
        break;
      case 'whatsapp':
        cfg.channels.whatsapp.enabled = false;
        break;
      default:
        throw new ValidationError('channel', `unknown channel: ${channel}`);
    }

    await configLoader.saveMaster(cfg);
    return { status: 'disabled', channel };
  };
}
