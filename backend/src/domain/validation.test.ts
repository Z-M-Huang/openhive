/**
 * Tests for domain validation functions.
 *
 * Verifies that each TypeScript validator:
 *   - Accepts valid inputs without throwing
 *   - Throws ValidationError with the correct field and message for each
 *     invalid input
 */

import { describe, it, expect } from 'vitest';
import {
  validateAID,
  validateTID,
  validateSlug,
  validateJID,
  validateJIDPrefix,
  validateTeam,
  validateAgent,
  validateProvider,
  isReservedSlug,
  slugToDisplayName,
  slugifyName,
  knownJIDPrefixes,
} from './validation.js';
import { ValidationError } from './errors.js';
import type { Team, Agent, Provider } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Asserts that fn throws a ValidationError with the given field and message
 * substring. This keeps individual test assertions concise.
 */
function expectValidationError(fn: () => void, field: string, messagePart: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ValidationError);
  const ve = caught as ValidationError;
  expect(ve.field).toBe(field);
  expect(ve.validationMessage).toContain(messagePart);
}

// ---------------------------------------------------------------------------
// validateAID
// ---------------------------------------------------------------------------

describe('validateAID', () => {
  it('accepts a well-formed AID', () => {
    expect(() => validateAID('aid-abc-123')).not.toThrow();
  });

  it('accepts AIDs with multiple chars in each segment', () => {
    expect(() => validateAID('aid-hello-world')).not.toThrow();
    expect(() => validateAID('aid-x-y')).not.toThrow();
    expect(() => validateAID('aid-123abc-456def')).not.toThrow();
  });

  it('rejects an empty string', () => {
    expectValidationError(() => validateAID(''), 'aid', 'cannot be empty');
  });

  it('rejects AID with wrong prefix (tid-)', () => {
    expectValidationError(() => validateAID('tid-abc-123'), 'aid', 'must match format');
  });

  it('rejects a bare prefix with no segments (aid-)', () => {
    expectValidationError(() => validateAID('aid-'), 'aid', 'must match format');
  });

  it('rejects AID with only one segment after prefix', () => {
    expectValidationError(() => validateAID('aid-abc'), 'aid', 'must match format');
  });

  it('rejects AID with uppercase letters', () => {
    expectValidationError(() => validateAID('aid-ABC-123'), 'aid', 'must match format');
  });

  it('rejects AID with no prefix at all', () => {
    expectValidationError(() => validateAID('abc-123'), 'aid', 'must match format');
  });

  it('rejects AID with trailing dash in segment', () => {
    expectValidationError(() => validateAID('aid-abc-'), 'aid', 'must match format');
  });

  it('rejects AID with three segments', () => {
    expectValidationError(() => validateAID('aid-abc-123-extra'), 'aid', 'must match format');
  });
});

// ---------------------------------------------------------------------------
// validateTID
// ---------------------------------------------------------------------------

describe('validateTID', () => {
  it('accepts a well-formed TID', () => {
    expect(() => validateTID('tid-abc-123')).not.toThrow();
  });

  it('accepts TIDs with numeric and alpha segments', () => {
    expect(() => validateTID('tid-team1-xyz99')).not.toThrow();
  });

  it('rejects an empty string', () => {
    expectValidationError(() => validateTID(''), 'tid', 'cannot be empty');
  });

  it('rejects TID with wrong prefix (aid-)', () => {
    expectValidationError(() => validateTID('aid-abc-123'), 'tid', 'must match format');
  });

  it('rejects bare prefix with no segments (tid-)', () => {
    expectValidationError(() => validateTID('tid-'), 'tid', 'must match format');
  });

  it('rejects TID with only one segment', () => {
    expectValidationError(() => validateTID('tid-abc'), 'tid', 'must match format');
  });

  it('rejects TID with uppercase letters', () => {
    expectValidationError(() => validateTID('tid-ABC-123'), 'tid', 'must match format');
  });
});

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------

describe('validateSlug', () => {
  it('accepts a simple lowercase slug', () => {
    expect(() => validateSlug('my-team')).not.toThrow();
  });

  it('accepts a slug with only letters', () => {
    expect(() => validateSlug('myteam')).not.toThrow();
  });

  it('accepts a slug with letters and numbers', () => {
    expect(() => validateSlug('team1')).not.toThrow();
    expect(() => validateSlug('team-1-alpha')).not.toThrow();
  });

  it('accepts a slug at exactly 63 characters', () => {
    const slug = 'a'.repeat(63);
    expect(() => validateSlug(slug)).not.toThrow();
  });

  it('rejects an empty string', () => {
    expectValidationError(() => validateSlug(''), 'slug', 'cannot be empty');
  });

  it('rejects a slug longer than 63 characters', () => {
    const slug = 'a'.repeat(64);
    expectValidationError(() => validateSlug(slug), 'slug', 'at most 63 characters');
  });

  it('rejects a slug containing .. (path traversal)', () => {
    expectValidationError(() => validateSlug('my..team'), 'slug', "must not contain '..'");
  });

  it('rejects a slug containing a forward slash', () => {
    expectValidationError(() => validateSlug('my/team'), 'slug', 'must not contain path separators');
  });

  it('rejects a slug containing a backslash', () => {
    expectValidationError(() => validateSlug('my\\team'), 'slug', 'must not contain path separators');
  });

  it('rejects uppercase letters', () => {
    expectValidationError(() => validateSlug('MyTeam'), 'slug', 'must be lowercase');
  });

  it('rejects a leading hyphen', () => {
    expectValidationError(() => validateSlug('-team'), 'slug', 'must be lowercase');
  });

  it('rejects a trailing hyphen', () => {
    expectValidationError(() => validateSlug('team-'), 'slug', 'must be lowercase');
  });

  it('rejects consecutive hyphens', () => {
    expectValidationError(() => validateSlug('my--team'), 'slug', 'must be lowercase');
  });

  it('rejects a slug that is just hyphens', () => {
    expectValidationError(() => validateSlug('---'), 'slug', 'must be lowercase');
  });
});

// ---------------------------------------------------------------------------
// validateJIDPrefix
// ---------------------------------------------------------------------------

describe('validateJIDPrefix', () => {
  it('accepts known prefixes: discord, whatsapp, api, cli', () => {
    expect(() => validateJIDPrefix('discord')).not.toThrow();
    expect(() => validateJIDPrefix('whatsapp')).not.toThrow();
    expect(() => validateJIDPrefix('api')).not.toThrow();
    expect(() => validateJIDPrefix('cli')).not.toThrow();
  });

  it('rejects an unknown prefix', () => {
    expectValidationError(() => validateJIDPrefix('telegram'), 'jid_prefix', 'unknown JID prefix');
  });

  it('rejects an empty string prefix', () => {
    expectValidationError(() => validateJIDPrefix(''), 'jid_prefix', 'unknown JID prefix');
  });
});

// ---------------------------------------------------------------------------
// validateJID
// ---------------------------------------------------------------------------

describe('validateJID', () => {
  it('accepts a valid discord JID', () => {
    expect(() => validateJID('discord:123:456')).not.toThrow();
  });

  it('accepts a valid whatsapp JID', () => {
    expect(() => validateJID('whatsapp:15551234567')).not.toThrow();
  });

  it('accepts a valid api JID', () => {
    expect(() => validateJID('api:42')).not.toThrow();
  });

  it('accepts a valid cli JID with any non-empty value', () => {
    expect(() => validateJID('cli:myuser')).not.toThrow();
    expect(() => validateJID('cli:user-at-host')).not.toThrow();
  });

  it('rejects an empty string', () => {
    expectValidationError(() => validateJID(''), 'jid', 'cannot be empty');
  });

  it('rejects a JID with no colon separator', () => {
    expectValidationError(() => validateJID('discord123'), 'jid', 'must have format');
  });

  it('rejects a JID with unknown prefix', () => {
    expectValidationError(() => validateJID('telegram:123'), 'jid', 'unknown JID prefix');
  });

  it('rejects discord JID with wrong format (missing second segment)', () => {
    expectValidationError(() => validateJID('discord:123'), 'jid', 'invalid JID format');
  });

  it('rejects discord JID with non-numeric segments', () => {
    expectValidationError(() => validateJID('discord:abc:def'), 'jid', 'invalid JID format');
  });

  it('rejects whatsapp JID with non-numeric value', () => {
    expectValidationError(() => validateJID('whatsapp:notanum'), 'jid', 'invalid JID format');
  });

  it('rejects api JID with non-numeric value', () => {
    expectValidationError(() => validateJID('api:notanum'), 'jid', 'invalid JID format');
  });

  it('rejects cli JID with empty value after colon', () => {
    expectValidationError(() => validateJID('cli:'), 'jid', 'invalid JID format');
  });
});

// ---------------------------------------------------------------------------
// isReservedSlug
// ---------------------------------------------------------------------------

describe('isReservedSlug', () => {
  it('returns true for "main"', () => {
    expect(isReservedSlug('main')).toBe(true);
  });

  it('returns true for "admin"', () => {
    expect(isReservedSlug('admin')).toBe(true);
  });

  it('returns true for "system"', () => {
    expect(isReservedSlug('system')).toBe(true);
  });

  it('returns true for "root"', () => {
    expect(isReservedSlug('root')).toBe(true);
  });

  it('returns true for "openhive"', () => {
    expect(isReservedSlug('openhive')).toBe(true);
  });

  it('returns false for a normal team slug', () => {
    expect(isReservedSlug('my-team')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isReservedSlug('')).toBe(false);
  });

  it('returns false for a prefix of a reserved slug', () => {
    expect(isReservedSlug('mai')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// slugToDisplayName
// ---------------------------------------------------------------------------

describe('slugToDisplayName', () => {
  it('converts "my-cool-team" to "My Cool Team"', () => {
    expect(slugToDisplayName('my-cool-team')).toBe('My Cool Team');
  });

  it('converts a single word slug', () => {
    expect(slugToDisplayName('marketing')).toBe('Marketing');
  });

  it('converts a two-word slug', () => {
    expect(slugToDisplayName('dev-ops')).toBe('Dev Ops');
  });

  it('converts a slug with numbers', () => {
    expect(slugToDisplayName('team-1')).toBe('Team 1');
  });

  it('converts single character parts', () => {
    expect(slugToDisplayName('a-b-c')).toBe('A B C');
  });

  it('converts single character parts (two parts)', () => {
    expect(slugToDisplayName('a-b')).toBe('A B');
  });

  it('preserves numbers in middle of part', () => {
    expect(slugToDisplayName('team1-beta2')).toBe('Team1 Beta2');
  });
});

// ---------------------------------------------------------------------------
// slugifyName
// ---------------------------------------------------------------------------

describe('slugifyName', () => {
  it('lowercases letters', () => {
    expect(slugifyName('Hello')).toBe('hello');
  });

  it('keeps digits', () => {
    expect(slugifyName('Agent42')).toBe('agent42');
  });

  it('converts spaces to hyphens', () => {
    expect(slugifyName('Lead Agent')).toBe('lead-agent');
  });

  it('collapses multiple spaces/hyphens to single hyphen', () => {
    expect(slugifyName('Lead  --  Agent')).toBe('lead-agent');
  });

  it('trims trailing hyphens', () => {
    expect(slugifyName('Lead-')).toBe('lead');
  });

  it('returns "agent" for empty/symbol-only names', () => {
    expect(slugifyName('')).toBe('agent');
    expect(slugifyName('!!!')).toBe('agent');
  });

  it('caps at 16 characters', () => {
    const long = 'averylongnamethatexceedssixteen';
    const result = slugifyName(long);
    expect(result.length).toBeLessThanOrEqual(16);
  });

  it('converts underscores to hyphens', () => {
    expect(slugifyName('my_agent')).toBe('my-agent');
  });
});

// ---------------------------------------------------------------------------
// knownJIDPrefixes
// ---------------------------------------------------------------------------

describe('knownJIDPrefixes', () => {
  it('returns an array containing all four known prefixes', () => {
    const prefixes = knownJIDPrefixes();
    expect(prefixes).toContain('discord');
    expect(prefixes).toContain('whatsapp');
    expect(prefixes).toContain('api');
    expect(prefixes).toContain('cli');
  });

  it('returns exactly four prefixes', () => {
    expect(knownJIDPrefixes()).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// validateTeam
// ---------------------------------------------------------------------------

describe('validateTeam', () => {
  const validTeam: Team = {
    tid: 'tid-abc-123',
    slug: 'my-team',
    leader_aid: 'aid-leader-001',
  };

  it('accepts a valid team', () => {
    expect(() => validateTeam(validTeam)).not.toThrow();
  });

  it('accepts a team with empty tid (tid is optional, empty means not yet assigned)', () => {
    const t: Team = { ...validTeam, tid: '' };
    expect(() => validateTeam(t)).not.toThrow();
  });

  it('accepts a team with undefined tid', () => {
    const { tid: _tid, ...rest } = validTeam;
    // tid is optional in type; cast to satisfy type
    expect(() => validateTeam(rest as Team)).not.toThrow();
  });

  it('rejects a team with invalid slug', () => {
    const t: Team = { ...validTeam, slug: 'Invalid-Slug' };
    expect(() => validateTeam(t)).toThrow(ValidationError);
  });

  it('rejects a team with empty leader_aid', () => {
    const t: Team = { ...validTeam, leader_aid: '' };
    expectValidationError(() => validateTeam(t), 'leader_aid', 'cannot be empty');
  });

  it('rejects a team with invalid leader_aid format', () => {
    const t: Team = { ...validTeam, leader_aid: 'not-an-aid' };
    expectValidationError(() => validateTeam(t), 'aid', 'must match format');
  });

  it('rejects a team with invalid TID format', () => {
    const t: Team = { ...validTeam, tid: 'bad-tid' };
    expectValidationError(() => validateTeam(t), 'tid', 'must match format');
  });
});

// ---------------------------------------------------------------------------
// validateAgent
// ---------------------------------------------------------------------------

describe('validateAgent', () => {
  const validAgent: Agent = {
    aid: 'aid-abc-123',
    name: 'My Agent',
  };

  it('accepts a valid agent', () => {
    expect(() => validateAgent(validAgent)).not.toThrow();
  });

  it('rejects an agent with empty aid', () => {
    const a: Agent = { ...validAgent, aid: '' };
    expectValidationError(() => validateAgent(a), 'aid', 'cannot be empty');
  });

  it('rejects an agent with invalid aid format', () => {
    const a: Agent = { ...validAgent, aid: 'notanaid' };
    expectValidationError(() => validateAgent(a), 'aid', 'must match format');
  });

  it('rejects an agent with empty name', () => {
    const a: Agent = { ...validAgent, name: '' };
    expectValidationError(() => validateAgent(a), 'name', 'cannot be empty');
  });
});

// ---------------------------------------------------------------------------
// validateProvider
// ---------------------------------------------------------------------------

// Provider test values: kept short (< 8 chars) to avoid security gate false
// positives. These are test-only dummy values, not real credentials.
const TEST_OAUTH_TOKEN = 'tok123';
const TEST_API_KEY = 'key123';

describe('validateProvider', () => {
  it('accepts a valid oauth provider with oauth_token set', () => {
    const p: Provider = {
      name: 'my-provider',
      type: 'oauth',
      oauth_token: TEST_OAUTH_TOKEN,
    };
    expect(() => validateProvider(p)).not.toThrow();
  });

  it('accepts a valid anthropic_direct provider with api_key set', () => {
    const p: Provider = {
      name: 'my-provider',
      type: 'anthropic_direct',
      api_key: TEST_API_KEY,
    };
    expect(() => validateProvider(p)).not.toThrow();
  });

  it('rejects a provider with empty name', () => {
    const p: Provider = {
      name: '',
      type: 'oauth',
      oauth_token: TEST_OAUTH_TOKEN,
    };
    expectValidationError(() => validateProvider(p), 'name', 'cannot be empty');
  });

  it('rejects a provider with unknown type', () => {
    const p: Provider = {
      name: 'my-provider',
      type: 'openai',
    };
    expectValidationError(() => validateProvider(p), 'type', 'unknown provider type');
  });

  it('rejects an oauth provider with no oauth_token field', () => {
    const p: Provider = {
      name: 'my-provider',
      type: 'oauth',
    };
    expectValidationError(() => validateProvider(p), 'oauth_token', 'required for oauth');
  });

  it('rejects an oauth provider with empty oauth_token', () => {
    const p: Provider = {
      name: 'my-provider',
      type: 'oauth',
      oauth_token: '',
    };
    expectValidationError(() => validateProvider(p), 'oauth_token', 'required for oauth');
  });

  it('rejects an anthropic_direct provider with no api_key field', () => {
    const p: Provider = {
      name: 'my-provider',
      type: 'anthropic_direct',
    };
    expectValidationError(() => validateProvider(p), 'api_key', 'required for anthropic_direct');
  });

  it('rejects an anthropic_direct provider with empty api_key', () => {
    const p: Provider = {
      name: 'my-provider',
      type: 'anthropic_direct',
      api_key: '',
    };
    expectValidationError(() => validateProvider(p), 'api_key', 'required for anthropic_direct');
  });
});
