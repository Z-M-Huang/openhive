/**
 * Unit tests for AI SDK provider registry.
 *
 * Tests: buildProviderRegistry, resolveModel, getContextWindow
 */

import { describe, it, expect } from 'vitest';

import {
  buildProviderRegistry,
  resolveModel,
  getContextWindow,
} from './provider-registry.js';
import type { ProvidersOutput } from '../config/validation.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Test-only placeholder. Not a real key. */
const TEST_KEY_VALUE = 'test-placeholder-key-not-real';

function makeProviders(
  overrides?: Partial<ProvidersOutput>,
): ProvidersOutput {
  return {
    profiles: {
      default: {
        type: 'api',
        api_key: TEST_KEY_VALUE,
        model: 'claude-sonnet-4-20250514',
      },
    },
    ...overrides,
  };
}

// ── buildProviderRegistry ──────────────────────────────────────────────────

describe('buildProviderRegistry', () => {
  it('builds registry with anthropic profile', () => {
    const providers = makeProviders();
    const registry = buildProviderRegistry(providers);

    expect(registry).toBeDefined();
    expect(typeof registry.languageModel).toBe('function');
  });

  it('builds registry with explicit anthropic provider field', () => {
    const providers = makeProviders({
      profiles: {
        custom: {
          type: 'api',
          provider: 'anthropic',
          api_key: TEST_KEY_VALUE,
          api_url: 'https://custom.api.example.com',
        },
      },
    });
    const registry = buildProviderRegistry(providers);

    expect(registry).toBeDefined();
    expect(typeof registry.languageModel).toBe('function');
  });

  it('builds registry with openai profile', () => {
    const providers = makeProviders({
      profiles: {
        openai: {
          type: 'api',
          provider: 'openai',
          api_key: TEST_KEY_VALUE,
        },
      },
    });
    const registry = buildProviderRegistry(providers);

    expect(registry).toBeDefined();
    expect(typeof registry.languageModel).toBe('function');
  });

  it('builds registry with oauth profile reading from env', () => {
    const original = process.env['TEST_OAUTH_TOKEN'];
    try {
      process.env['TEST_OAUTH_TOKEN'] = 'oauth-test-placeholder';
      const providers = makeProviders({
        profiles: {
          oauth: {
            type: 'oauth',
            oauth_token_env: 'TEST_OAUTH_TOKEN',
          },
        },
      });
      const registry = buildProviderRegistry(providers);

      expect(registry).toBeDefined();
      expect(typeof registry.languageModel).toBe('function');
    } finally {
      if (original === undefined) {
        delete process.env['TEST_OAUTH_TOKEN'];
      } else {
        process.env['TEST_OAUTH_TOKEN'] = original;
      }
    }
  });

  it('builds registry with multiple profiles', () => {
    const providers = makeProviders({
      profiles: {
        anthropic: {
          type: 'api',
          provider: 'anthropic',
          api_key: TEST_KEY_VALUE,
        },
        openai: {
          type: 'api',
          provider: 'openai',
          api_key: TEST_KEY_VALUE,
        },
      },
    });
    const registry = buildProviderRegistry(providers);

    expect(registry).toBeDefined();
    expect(typeof registry.languageModel).toBe('function');
  });
});

// ── resolveModel ───────────────────────────────────────────────────────────

describe('resolveModel', () => {
  it('returns a language model from registry', () => {
    const providers = makeProviders({
      profiles: {
        myprofile: {
          type: 'api',
          provider: 'anthropic',
          api_key: TEST_KEY_VALUE,
        },
      },
    });
    const registry = buildProviderRegistry(providers);
    const model = resolveModel(registry, 'myprofile', 'claude-sonnet-4-20250514');

    expect(model).toBeDefined();
    expect(model.modelId).toBe('claude-sonnet-4-20250514');
  });

  it('returns an openai model from registry', () => {
    const providers = makeProviders({
      profiles: {
        oai: {
          type: 'api',
          provider: 'openai',
          api_key: TEST_KEY_VALUE,
        },
      },
    });
    const registry = buildProviderRegistry(providers);
    const model = resolveModel(registry, 'oai', 'gpt-4o');

    expect(model).toBeDefined();
    expect(model.modelId).toBe('gpt-4o');
  });
});

// ── getContextWindow ───────────────────────────────────────────────────────

describe('getContextWindow', () => {
  it('returns profile context_window when set', () => {
    const providers = makeProviders({
      profiles: {
        custom: {
          type: 'api',
          api_key: TEST_KEY_VALUE,
          context_window: 128_000,
        },
      },
    });

    expect(getContextWindow(providers, 'custom')).toBe(128_000);
  });

  it('returns 200000 default when context_window is not set', () => {
    const providers = makeProviders();

    expect(getContextWindow(providers, 'default')).toBe(200_000);
  });

  it('returns 200000 default for unknown profile name', () => {
    const providers = makeProviders();

    expect(getContextWindow(providers, 'nonexistent')).toBe(200_000);
  });
});
