/**
 * UT-18: Provider Resolver
 *
 * Tests: Provider resolver maps api/oauth profiles, throws on missing
 */

import { describe, it, expect } from 'vitest';

import { resolveProvider } from './provider-resolver.js';
import { ConfigError } from '../domain/errors.js';
import type { ProvidersOutput } from '../config/validation.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Test-only placeholder. Not a real key. */
const TEST_KEY_VALUE = 'test-placeholder-key-not-real';

function makeProviders(overrides?: Partial<ProvidersOutput>): ProvidersOutput {
  return {
    profiles: {
      default: {
        type: 'api',
        api_key: TEST_KEY_VALUE,
        model: 'claude-sonnet-4-20250514',
      },
      oauth: {
        type: 'oauth',
        oauth_token_env: 'MY_OAUTH_TOKEN',
      },
    },
    ...overrides,
  };
}

// ── UT-18: Provider Resolver ──────────────────────────────────────────────

describe('UT-18: Provider Resolver', () => {
  it('maps api profile correctly', () => {
    const providers = makeProviders();
    const resolved = resolveProvider('default', providers);

    expect(resolved.model).toBe('claude-sonnet-4-20250514');
    expect(resolved.env).toEqual({
      ANTHROPIC_API_KEY: TEST_KEY_VALUE,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-20250514',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-20250514',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-4-20250514',
    });
  });

  it('includes ANTHROPIC_BASE_URL when api_url is set', () => {
    const providers = makeProviders({
      profiles: {
        custom: {
          type: 'api',
          api_key: TEST_KEY_VALUE,
          model: 'claude-haiku-2',
          api_url: 'https://custom.api.example.com',
        },
      },
    });
    const resolved = resolveProvider('custom', providers);

    expect(resolved.env['ANTHROPIC_BASE_URL']).toBe('https://custom.api.example.com');
    expect(resolved.env['ANTHROPIC_API_KEY']).toBe(TEST_KEY_VALUE);
    expect(resolved.model).toBe('claude-haiku-2');
  });

  it('maps oauth profile correctly', () => {
    const original = process.env['MY_OAUTH_TOKEN'];
    try {
      process.env['MY_OAUTH_TOKEN'] = 'oauth-test-placeholder';
      const providers = makeProviders();
      const resolved = resolveProvider('oauth', providers);

      expect(resolved.env).toEqual({
        CLAUDE_CODE_OAUTH_TOKEN: 'oauth-test-placeholder',
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-20250514',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-20250514',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-4-20250514',
      });
    } finally {
      if (original === undefined) {
        delete process.env['MY_OAUTH_TOKEN'];
      } else {
        process.env['MY_OAUTH_TOKEN'] = original;
      }
    }
  });

  it('throws ConfigError on missing profile', () => {
    const providers = makeProviders();

    expect(() => resolveProvider('nonexistent', providers)).toThrow(ConfigError);
    expect(() => resolveProvider('nonexistent', providers)).toThrow('not found');
  });

  it('throws ConfigError when oauth env var not set', () => {
    const original = process.env['MY_OAUTH_TOKEN'];
    try {
      delete process.env['MY_OAUTH_TOKEN'];
      const providers = makeProviders();

      expect(() => resolveProvider('oauth', providers)).toThrow(ConfigError);
      expect(() => resolveProvider('oauth', providers)).toThrow('not set');
    } finally {
      if (original !== undefined) {
        process.env['MY_OAUTH_TOKEN'] = original;
      }
    }
  });
});
