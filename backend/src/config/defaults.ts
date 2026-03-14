/**
 * Compiled defaults for OpenHive master configuration.
 *
 * These defaults form the first layer of the three-layer config resolution chain:
 *   1. Compiled defaults (this file) — safe starting values so the system boots with minimal config
 *   2. YAML files (data/openhive.yaml) — override compiled defaults field-by-field
 *   3. Environment variables (OPENHIVE_*) — override YAML values
 *
 * All values match Configuration-Schemas.md § "Compiled Defaults" exactly.
 */

import type { TriggerConfig } from '../domain/triggers.js';
import type { MCPServerConfig } from '../domain/interfaces.js';

// ---------------------------------------------------------------------------
// MasterConfig Type
// ---------------------------------------------------------------------------

export interface LogArchiveConfig {
  enabled: boolean;
  max_entries: number;
  keep_copies: number;
  archive_dir: string;
}

export interface MessageArchiveConfig {
  enabled: boolean;
  max_entries: number;
  keep_copies: number;
  archive_dir: string;
}

export interface ServerConfig {
  listen_address: string;
  data_dir: string;
  log_level: string;
  log_archive: LogArchiveConfig;
  max_message_length: number;
  default_idle_timeout: string;
  event_bus_workers: number;
  portal_ws_max_connections: number;
  message_archive: MessageArchiveConfig;
}

export interface DatabasePragma {
  journal_size_limit: number;
  cache_size: number;
  busy_timeout: number;
}

export interface DatabaseConfig {
  path: string;
  wal_mode: boolean;
  pragma: DatabasePragma;
}

export interface ResourceLimits {
  max_memory: string;
  max_cpus: number;
  max_old_space: number;
}

export interface DockerConfig {
  image: string;
  network: string;
  resource_limits: ResourceLimits;
}

export interface SecurityConfig {
  encryption_key_path: string;
  token_ttl: string;
  allowed_origins: string[];
}

export interface LimitsConfig {
  max_depth: number;
  max_teams: number;
  max_agents_per_team: number;
  max_concurrent_tasks: number;
}

export interface AssistantConfig {
  name: string;
  aid: string;
  provider: string;
  model_tier: string;
  max_turns: number;
  timeout_minutes: number;
}

export interface ChannelConfig {
  enabled: boolean;
  token_env?: string;
  prefix?: string;
  channel_id?: string;
}

export interface ChannelsConfig {
  discord: ChannelConfig;
  slack: ChannelConfig;
}

export interface AgentRef {
  aid: string;
  name: string;
  leads_team?: string;
}

// ---------------------------------------------------------------------------
// Team Config Types (YAML schema representation)
// ---------------------------------------------------------------------------

export interface TeamAgentConfig {
  aid: string;
  name: string;
  provider?: string;
  model_tier?: string;
  skills?: string[];
  max_turns?: number;
  timeout_minutes?: number;
  leads_team?: string;
  proactive_interval_minutes?: number;
}

export interface TeamResourceLimits {
  max_memory?: string;
  max_cpus?: number;
  max_old_space?: number;
  idle_timeout?: string;
}

export interface TeamConfig {
  slug: string;
  parent_slug?: string;
  leader_aid: string;
  tid?: string;
  description?: string;
  agents?: TeamAgentConfig[];
  mcp_servers?: MCPServerConfig[];
  triggers?: TriggerConfig[];
  proactive_interval_minutes?: number;
  resource_limits?: TeamResourceLimits;
  children?: string[];
  env_vars?: Record<string, string>;
}

export interface MasterConfig {
  server: ServerConfig;
  database: DatabaseConfig;
  docker: DockerConfig;
  security: SecurityConfig;
  limits: LimitsConfig;
  assistant: AssistantConfig;
  channels: ChannelsConfig;
  triggers?: TriggerConfig[];
  skill_registries?: string[];
  agents?: AgentRef[];
  providers?: string;
}

// ---------------------------------------------------------------------------
// Default Values
// ---------------------------------------------------------------------------

/**
 * Returns the compiled default configuration for OpenHive.
 *
 * Every field has a safe default so the system can boot with a minimal
 * (or empty) `openhive.yaml`. Values are overridden by YAML config,
 * then by OPENHIVE_* environment variables at runtime.
 */
export function defaultMasterConfig(): MasterConfig {
  return {
    server: {
      listen_address: '127.0.0.1:8080',
      data_dir: 'data',
      log_level: 'info',
      log_archive: {
        enabled: true,
        max_entries: 100_000,
        keep_copies: 5,
        archive_dir: 'data/archives',
      },
      max_message_length: 0,
      default_idle_timeout: '',
      event_bus_workers: 0,
      portal_ws_max_connections: 0,
      message_archive: {
        enabled: false,
        max_entries: 0,
        keep_copies: 0,
        archive_dir: '',
      },
    },
    database: {
      path: 'data/openhive.db',
      wal_mode: true,
      pragma: {
        journal_size_limit: 67_108_864,
        cache_size: -2000,
        busy_timeout: 5000,
      },
    },
    docker: {
      image: 'openhive',
      network: 'openhive-network',
      resource_limits: {
        max_memory: '1024m',
        max_cpus: 1.0,
        max_old_space: 768,
      },
    },
    security: {
      encryption_key_path: 'data/master.key',
      token_ttl: '5m',
      allowed_origins: ['http://localhost:8080'],
    },
    limits: {
      max_depth: 3,
      max_teams: 10,
      max_agents_per_team: 5,
      max_concurrent_tasks: 50,
    },
    assistant: {
      name: 'OpenHive Assistant',
      aid: 'aid-main-001',
      provider: 'default',
      model_tier: 'sonnet',
      max_turns: 50,
      timeout_minutes: 10,
    },
    channels: {
      discord: { enabled: false },
      slack: { enabled: false },
    },
  };
}
