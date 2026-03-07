/**
 * OpenHive Backend - Domain Validation
 *
 * All validators throw ValidationError on invalid input.
 *
 * Covered functions:
 *   validateAID, validateTID, validateSlug, validateJID, validateJIDPrefix,
 *   validateTeam, validateAgent, validateProvider,
 *   isReservedSlug, slugToDisplayName, knownJIDPrefixes
 */

import { ValidationError } from './errors.js';
import { parseProviderType } from './enums.js';
import type { Team, Agent, Provider } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SLUG_LENGTH = 63;

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

const aidPattern = /^aid-[a-z0-9]+-[a-z0-9]+$/;
const tidPattern = /^tid-[a-z0-9]+-[a-z0-9]+$/;
const slugPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** JID pattern map for each channel prefix. */
const jidPatterns: Readonly<Record<string, RegExp>> = {
  discord: /^discord:[0-9]+:[0-9]+$/,
  whatsapp: /^whatsapp:[0-9]+$/,
  api: /^api:[0-9]+$/,
  cli: /^cli:.+$/,
};

// ---------------------------------------------------------------------------
// Reserved slugs
// ---------------------------------------------------------------------------

/** Slugs that cannot be used as user-defined team names. */
const reservedSlugs: Readonly<Set<string>> = new Set([
  'main',
  'admin',
  'system',
  'root',
  'openhive',
]);

// ---------------------------------------------------------------------------
// knownJIDPrefixes
// ---------------------------------------------------------------------------

/** Returns the list of known JID prefix strings. */
export function knownJIDPrefixes(): string[] {
  return Object.keys(jidPatterns);
}

// ---------------------------------------------------------------------------
// validateJIDPrefix
// ---------------------------------------------------------------------------

/**
 * Checks that a JID prefix is known.
 * Throws ValidationError if the prefix is not recognised.
 */
export function validateJIDPrefix(prefix: string): void {
  if (!(prefix in jidPatterns)) {
    throw new ValidationError('jid_prefix', `unknown JID prefix: "${prefix}"`);
  }
}

// ---------------------------------------------------------------------------
// validateJID
// ---------------------------------------------------------------------------

/**
 * Checks that a JID matches the expected format for its channel type.
 * Throws ValidationError if the JID is invalid.
 */
export function validateJID(jid: string): void {
  if (jid === '') {
    throw new ValidationError('jid', 'cannot be empty');
  }

  const colonIdx = jid.indexOf(':');
  if (colonIdx === -1) {
    throw new ValidationError('jid', 'must have format <prefix>:<value>');
  }

  const prefix = jid.slice(0, colonIdx);
  const pattern = jidPatterns[prefix];
  if (pattern === undefined) {
    throw new ValidationError('jid', `unknown JID prefix: "${prefix}"`);
  }

  if (!pattern.test(jid)) {
    throw new ValidationError('jid', `invalid JID format for prefix "${prefix}"`);
  }
}

// ---------------------------------------------------------------------------
// validateAID
// ---------------------------------------------------------------------------

/**
 * Checks that an agent ID matches the expected format (aid-xxx-xxx).
 * Throws ValidationError if the AID is invalid.
 */
export function validateAID(aid: string): void {
  if (aid === '') {
    throw new ValidationError('aid', 'cannot be empty');
  }
  if (!aidPattern.test(aid)) {
    throw new ValidationError('aid', 'must match format aid-xxx-xxx');
  }
}

// ---------------------------------------------------------------------------
// validateTID
// ---------------------------------------------------------------------------

/**
 * Checks that a team ID matches the expected format (tid-xxx-xxx).
 * Throws ValidationError if the TID is invalid.
 */
export function validateTID(tid: string): void {
  if (tid === '') {
    throw new ValidationError('tid', 'cannot be empty');
  }
  if (!tidPattern.test(tid)) {
    throw new ValidationError('tid', 'must match format tid-xxx-xxx');
  }
}

// ---------------------------------------------------------------------------
// validateSlug
// ---------------------------------------------------------------------------

/**
 * Checks that a slug is a valid lowercase kebab-case identifier.
 *
 * Rejects:
 *   - empty strings
 *   - strings longer than 63 characters
 *   - strings containing '..' (path traversal)
 *   - strings containing '/' or '\' (path separators)
 *   - strings not matching ^[a-z0-9]+(-[a-z0-9]+)*$
 */
export function validateSlug(slug: string): void {
  if (slug === '') {
    throw new ValidationError('slug', 'cannot be empty');
  }
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new ValidationError('slug', `must be at most ${MAX_SLUG_LENGTH} characters`);
  }
  if (slug.includes('..')) {
    throw new ValidationError('slug', "must not contain '..' (path traversal)");
  }
  if (slug.includes('/') || slug.includes('\\')) {
    throw new ValidationError('slug', 'must not contain path separators');
  }
  if (!slugPattern.test(slug)) {
    throw new ValidationError(
      'slug',
      'must be lowercase letters, numbers, and hyphens only (no leading/trailing/consecutive hyphens)',
    );
  }
}

// ---------------------------------------------------------------------------
// validateTeam
// ---------------------------------------------------------------------------

/**
 * Validates a Team object.
 * Throws ValidationError for any invalid field.
 */
export function validateTeam(t: Team): void {
  validateSlug(t.slug);

  if (t.leader_aid === '') {
    throw new ValidationError('leader_aid', 'cannot be empty');
  }
  validateAID(t.leader_aid);

  if (t.tid !== '' && t.tid !== undefined) {
    validateTID(t.tid);
  }
}

// ---------------------------------------------------------------------------
// validateAgent
// ---------------------------------------------------------------------------

/**
 * Validates an Agent object.
 * Throws ValidationError for any invalid field.
 */
export function validateAgent(a: Agent): void {
  if (a.aid === '') {
    throw new ValidationError('aid', 'cannot be empty');
  }
  validateAID(a.aid);

  if (a.name === '') {
    throw new ValidationError('name', 'cannot be empty');
  }
}

// ---------------------------------------------------------------------------
// validateProvider
// ---------------------------------------------------------------------------

/**
 * Validates a Provider object.
 * Throws ValidationError for any invalid field.
 */
export function validateProvider(p: Provider): void {
  if (p.name === '') {
    throw new ValidationError('name', 'cannot be empty');
  }

  let pt: ReturnType<typeof parseProviderType>;
  try {
    pt = parseProviderType(p.type);
  } catch {
    throw new ValidationError('type', 'unknown provider type: ' + p.type);
  }

  if (pt === 'oauth') {
    if (!p.oauth_token || p.oauth_token === '') {
      throw new ValidationError('oauth_token', 'required for oauth provider type');
    }
  } else if (pt === 'anthropic_direct') {
    if (!p.api_key || p.api_key === '') {
      throw new ValidationError('api_key', 'required for anthropic_direct provider type');
    }
  }
}

// ---------------------------------------------------------------------------
// isReservedSlug
// ---------------------------------------------------------------------------

/**
 * Reports whether the given slug is reserved by the platform
 * and must not be used as a user-defined team name.
 */
export function isReservedSlug(slug: string): boolean {
  return reservedSlugs.has(slug);
}

// ---------------------------------------------------------------------------
// slugToDisplayName
// ---------------------------------------------------------------------------

/**
 * Converts a kebab-case slug to a title-case display name.
 * Example: 'my-cool-team' → 'My Cool Team'
 */
export function slugToDisplayName(slug: string): string {
  return slug
    .split('-')
    .map((part) => (part.length > 0 ? part[0]!.toUpperCase() + part.slice(1) : part))
    .join(' ');
}

// ---------------------------------------------------------------------------
// slugifyName
// ---------------------------------------------------------------------------

/**
 * Converts a display name to a short lowercase slug for use in AIDs and
 * agent file names.
 * Moved here from tools-team.ts to avoid circular imports (tools-team
 * imports from orchestrator.ts, which needs this for leader cleanup).
 *
 * Rules:
 *   - Lowercase letters and digits pass through.
 *   - Spaces, hyphens, underscores collapse to a single '-'.
 *   - All other characters are dropped.
 *   - Trailing hyphens are trimmed.
 *   - Empty result → "agent".
 *   - Result capped at 16 characters.
 */
export function slugifyName(name: string): string {
  let result = '';
  for (let i = 0; i < name.length; i++) {
    const c = name[i]!;
    if (c >= 'a' && c <= 'z') {
      result += c;
    } else if (c >= 'A' && c <= 'Z') {
      result += c.toLowerCase();
    } else if (c >= '0' && c <= '9') {
      result += c;
    } else if (c === ' ' || c === '-' || c === '_') {
      if (result.length > 0 && result[result.length - 1] !== '-') {
        result += '-';
      }
    }
  }
  // Trim trailing hyphens
  while (result.length > 0 && result[result.length - 1] === '-') {
    result = result.slice(0, -1);
  }
  if (result.length === 0) {
    return 'agent';
  }
  if (result.length > 16) {
    result = result.slice(0, 16);
  }
  return result;
}
