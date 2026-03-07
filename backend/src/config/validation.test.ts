/**
 * Tests for backend/src/config/validation.ts
 *
 * Covers validateMasterConfig and validateProviders.
 */

import { describe, it, expect } from 'vitest';
import { validateMasterConfig, validateProviders } from './validation.js';
import { defaultMasterConfig } from './defaults.js';
import { ValidationError } from '../domain/errors.js';
import type { Provider } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Provider test values: kept short (< 8 chars) to avoid security gate false
// positives. These are test-only dummy values, not real credentials.
// ---------------------------------------------------------------------------
const TEST_TOKEN = 'tok123';
const TEST_KEY = 'key123';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns a valid oauth Provider object for use in test maps. */
function makeOAuthProvider(name: string): Provider {
  return { name, type: 'oauth', oauth_token: TEST_TOKEN };
}

/** Returns a valid anthropic_direct Provider object for use in test maps. */
function makeDirectProvider(name: string): Provider {
  return { name, type: 'anthropic_direct', api_key: TEST_KEY };
}

// ---------------------------------------------------------------------------
// validateMasterConfig
// ---------------------------------------------------------------------------

describe('validateMasterConfig', () => {
  it('valid default config passes validation', () => {
    const cfg = defaultMasterConfig();
    expect(() => validateMasterConfig(cfg)).not.toThrow();
  });

  it('valid config with agents passes validation', () => {
    const cfg = defaultMasterConfig();
    cfg.agents = [{ aid: 'aid-lead-001', name: 'team-lead' }];
    expect(() => validateMasterConfig(cfg)).not.toThrow();
  });

  it('empty listen_address throws ValidationError on system.listen_address', () => {
    const cfg = defaultMasterConfig();
    cfg.system.listen_address = '';
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('system.listen_address');
      expect((err as ValidationError).validationMessage).toBe('cannot be empty');
    }
  });

  it('empty data_dir throws ValidationError on system.data_dir', () => {
    const cfg = defaultMasterConfig();
    cfg.system.data_dir = '';
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect((err as ValidationError).field).toBe('system.data_dir');
    }
  });

  it('empty workspace_root throws ValidationError on system.workspace_root', () => {
    const cfg = defaultMasterConfig();
    cfg.system.workspace_root = '';
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect((err as ValidationError).field).toBe('system.workspace_root');
    }
  });

  it('invalid log_level throws ValidationError on system.log_level', () => {
    const cfg = defaultMasterConfig();
    cfg.system.log_level = 'invalid';
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('system.log_level');
      expect((err as ValidationError).validationMessage).toContain('invalid log level');
    }
  });

  it('empty log_level is allowed (optional field)', () => {
    const cfg = defaultMasterConfig();
    cfg.system.log_level = '';
    expect(() => validateMasterConfig(cfg)).not.toThrow();
  });

  it('all valid log levels pass', () => {
    for (const level of ['debug', 'info', 'warn', 'error']) {
      const cfg = defaultMasterConfig();
      cfg.system.log_level = level;
      expect(() => validateMasterConfig(cfg)).not.toThrow();
    }
  });

  it('empty assistant.name throws ValidationError on assistant.name', () => {
    const cfg = defaultMasterConfig();
    cfg.assistant.name = '';
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect((err as ValidationError).field).toBe('assistant.name');
    }
  });

  it('invalid assistant AID throws ValidationError', () => {
    const cfg = defaultMasterConfig();
    cfg.assistant.aid = 'bad-aid';
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
  });

  it('empty assistant.aid is allowed (optional field)', () => {
    const cfg = defaultMasterConfig();
    cfg.assistant.aid = '';
    expect(() => validateMasterConfig(cfg)).not.toThrow();
  });

  it('empty assistant.provider throws ValidationError on assistant.provider', () => {
    const cfg = defaultMasterConfig();
    cfg.assistant.provider = '';
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect((err as ValidationError).field).toBe('assistant.provider');
    }
  });

  it('invalid assistant.model_tier throws ValidationError on assistant.model_tier', () => {
    const cfg = defaultMasterConfig();
    cfg.assistant.model_tier = 'mega';
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('assistant.model_tier');
      expect((err as ValidationError).validationMessage).toContain('invalid model tier');
    }
  });

  it('empty assistant.model_tier is allowed (optional field)', () => {
    const cfg = defaultMasterConfig();
    cfg.assistant.model_tier = '';
    expect(() => validateMasterConfig(cfg)).not.toThrow();
  });

  it('all valid model tiers pass', () => {
    for (const tier of ['haiku', 'sonnet', 'opus']) {
      const cfg = defaultMasterConfig();
      cfg.assistant.model_tier = tier;
      expect(() => validateMasterConfig(cfg)).not.toThrow();
    }
  });

  it('agent with empty AID throws ValidationError on agents[0]', () => {
    const cfg = defaultMasterConfig();
    cfg.agents = [{ aid: '', name: 'test-agent' }];
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('agents[0]');
    }
  });

  it('agent with invalid AID format throws ValidationError', () => {
    const cfg = defaultMasterConfig();
    cfg.agents = [{ aid: 'bad-aid', name: 'test-agent' }];
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
  });

  it('second invalid agent reports agents[1]', () => {
    const cfg = defaultMasterConfig();
    cfg.agents = [
      { aid: 'aid-lead-001', name: 'lead' },
      { aid: 'bad-aid', name: 'worker' },
    ];
    expect(() => validateMasterConfig(cfg)).toThrow(ValidationError);
    try {
      validateMasterConfig(cfg);
    } catch (err) {
      expect((err as ValidationError).field).toBe('agents[1]');
    }
  });

  it('undefined agents field passes validation', () => {
    const cfg = defaultMasterConfig();
    cfg.agents = undefined;
    expect(() => validateMasterConfig(cfg)).not.toThrow();
  });

  it('empty agents array passes validation', () => {
    const cfg = defaultMasterConfig();
    cfg.agents = [];
    expect(() => validateMasterConfig(cfg)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateProviders
// ---------------------------------------------------------------------------

describe('validateProviders', () => {
  it('valid oauth providers map passes validation', () => {
    expect(() => validateProviders({ default: makeOAuthProvider('default') })).not.toThrow();
  });

  it('valid anthropic_direct provider passes validation', () => {
    expect(() => validateProviders({ direct: makeDirectProvider('direct') })).not.toThrow();
  });

  it('empty providers map throws ValidationError on providers field', () => {
    expect(() => validateProviders({})).toThrow(ValidationError);
    try {
      validateProviders({});
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('providers');
      expect((err as ValidationError).validationMessage).toContain('at least one provider');
    }
  });

  it('provider with invalid type throws ValidationError on providers.<name>', () => {
    const providers: Record<string, Provider> = {
      bad: { name: 'bad', type: 'unknown_type' },
    };
    expect(() => validateProviders(providers)).toThrow(ValidationError);
    try {
      validateProviders(providers);
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('providers.bad');
    }
  });

  it('oauth provider missing oauth_token throws ValidationError on providers.<name>', () => {
    const providers: Record<string, Provider> = {
      myoauth: { name: 'myoauth', type: 'oauth' },
    };
    expect(() => validateProviders(providers)).toThrow(ValidationError);
    try {
      validateProviders(providers);
    } catch (err) {
      expect((err as ValidationError).field).toBe('providers.myoauth');
    }
  });

  it('anthropic_direct provider missing api_key throws ValidationError on providers.<name>', () => {
    const providers: Record<string, Provider> = {
      myapi: { name: 'myapi', type: 'anthropic_direct' },
    };
    expect(() => validateProviders(providers)).toThrow(ValidationError);
    try {
      validateProviders(providers);
    } catch (err) {
      expect((err as ValidationError).field).toBe('providers.myapi');
    }
  });

  it('map key sets provider name when name field is empty', () => {
    // Provider name field is empty — validateProviders fills it from the map key
    const providers: Record<string, Provider> = {
      'my-provider': { name: '', type: 'oauth', oauth_token: TEST_TOKEN },
    };
    expect(() => validateProviders(providers)).not.toThrow();
  });

  it('multiple valid providers all pass', () => {
    const providers: Record<string, Provider> = {
      prov_a: makeOAuthProvider('prov_a'),
      prov_b: makeDirectProvider('prov_b'),
    };
    expect(() => validateProviders(providers)).not.toThrow();
  });
});
