/**
 * Tests for defaultMasterConfig()
 *
 * Verifies that all default values are set correctly.
 */

import { describe, it, expect } from 'vitest';
import { defaultMasterConfig } from './defaults.js';

describe('defaultMasterConfig', () => {
  it('returns an object with all expected default system values', () => {
    const cfg = defaultMasterConfig();

    expect(cfg.system.listen_address).toBe('127.0.0.1:8080');
    expect(cfg.system.data_dir).toBe('data');
    expect(cfg.system.workspace_root).toBe('/openhive/workspace');
    expect(cfg.system.log_level).toBe('info');
  });

  it('returns default log_archive config', () => {
    const cfg = defaultMasterConfig();

    expect(cfg.system.log_archive.enabled).toBe(true);
    expect(cfg.system.log_archive.max_entries).toBe(100000);
    expect(cfg.system.log_archive.keep_copies).toBe(5);
    expect(cfg.system.log_archive.archive_dir).toBe('data/archives');
  });

  it('returns default assistant config', () => {
    const cfg = defaultMasterConfig();

    expect(cfg.assistant.name).toBe('OpenHive Assistant');
    expect(cfg.assistant.aid).toBe('aid-main-001');
    expect(cfg.assistant.provider).toBe('default');
    expect(cfg.assistant.model_tier).toBe('sonnet');
    expect(cfg.assistant.max_turns).toBe(50);
    expect(cfg.assistant.timeout_minutes).toBe(10);
  });

  it('returns default channels config with both channels disabled', () => {
    const cfg = defaultMasterConfig();

    expect(cfg.channels.discord.enabled).toBe(false);
    expect(cfg.channels.whatsapp.enabled).toBe(false);
  });

  it('returns zero-valued system fields for optional settings', () => {
    const cfg = defaultMasterConfig();

    expect(cfg.system.max_message_length).toBe(0);
    expect(cfg.system.default_idle_timeout).toBe('');
    expect(cfg.system.event_bus_workers).toBe(0);
    expect(cfg.system.portal_ws_max_connections).toBe(0);
  });

  it('returns zero-valued message_archive for optional settings', () => {
    const cfg = defaultMasterConfig();

    expect(cfg.system.message_archive.enabled).toBe(false);
    expect(cfg.system.message_archive.max_entries).toBe(0);
    expect(cfg.system.message_archive.keep_copies).toBe(0);
    expect(cfg.system.message_archive.archive_dir).toBe('');
  });

  it('returns a new object on each call (no shared state)', () => {
    const cfg1 = defaultMasterConfig();
    const cfg2 = defaultMasterConfig();

    expect(cfg1).not.toBe(cfg2);
    expect(cfg1.system).not.toBe(cfg2.system);
    expect(cfg1.assistant).not.toBe(cfg2.assistant);
    expect(cfg1.channels).not.toBe(cfg2.channels);
  });

  it('does not set optional agents list', () => {
    const cfg = defaultMasterConfig();

    expect(cfg.agents).toBeUndefined();
  });

  it('returns default system limits', () => {
    const cfg = defaultMasterConfig();

    expect(cfg.system.limits.max_depth).toBe(5);
    expect(cfg.system.limits.max_teams).toBe(20);
    expect(cfg.system.limits.max_agents_per_team).toBe(10);
    expect(cfg.system.limits.max_concurrent_tasks).toBe(50);
  });
});
