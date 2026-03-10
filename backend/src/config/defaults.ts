/**
 * OpenHive Backend - Config Defaults
 *
 * Provides compiled-in default values for MasterConfig.
 *
 * Loading order:
 *   1. defaultMasterConfig() — compiled-in defaults (this file)
 *   2. YAML config file overrides
 *   3. Environment variable overrides (OPENHIVE_* prefix)
 */

import type { MasterConfig } from '../domain/types.js';

/**
 * Returns a new MasterConfig populated with compiled-in default values.
 */
export function defaultMasterConfig(): MasterConfig {
  return {
    system: {
      listen_address: '127.0.0.1:8080',
      data_dir: 'data',
      workspace_root: '/openhive/workspace',
      log_level: 'info',
      log_archive: {
        enabled: true,
        max_entries: 100000,
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
      limits: {
        max_depth: 5,
        max_teams: 20,
        max_agents_per_team: 10,
        max_concurrent_tasks: 50,
      },
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
      whatsapp: { enabled: false },
    },
  };
}
