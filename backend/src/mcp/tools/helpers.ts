/**
 * Shared helpers for MCP tool handlers.
 *
 * @module mcp/tools/helpers
 */

import crypto from 'node:crypto';
import { URL } from 'node:url';

// ---------------------------------------------------------------------------
// Private-IP blocklist — prevents agents from reaching localhost, cloud
// metadata, or internal network services via integration HTTP calls.
// ---------------------------------------------------------------------------

const PRIVATE_HOSTNAME_BLOCKLIST = new Set([
  'localhost',
  'metadata.google.internal',
  'metadata.google',
]);

/**
 * Checks whether a URL targets a private/internal network address.
 * Throws if the hostname resolves to a loopback, link-local, private RFC-1918,
 * or cloud metadata IP range.
 */
export function assertNotPrivateUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }

  // Only allow HTTP(S) — block file://, data:, javascript:, ftp:// etc.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Blocked non-HTTP URL scheme: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block well-known internal hostnames
  if (PRIVATE_HOSTNAME_BLOCKLIST.has(hostname)) {
    throw new Error(`Blocked request to private hostname: ${hostname}`);
  }

  // Block IPv4 private/reserved ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 127 ||                          // 127.0.0.0/8 loopback
      a === 10 ||                           // 10.0.0.0/8 private
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 private
      (a === 192 && b === 168) ||           // 192.168.0.0/16 private
      (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local / cloud metadata
      a === 0                               // 0.0.0.0/8
    ) {
      throw new Error(`Blocked request to private IP: ${hostname}`);
    }
  }

  // Block IPv6 loopback and link-local (bracket-stripped by URL parser)
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (bare === '::1' || bare === '::' || bare.startsWith('fe80:') || bare.startsWith('fc') || bare.startsWith('fd')) {
    throw new Error(`Blocked request to private IPv6 address: ${hostname}`);
  }
}

/** Generate a prefixed ID with random hex suffix. */
export function generateId(prefix: string, name: string): string {
  const hex = crypto.randomBytes(4).toString('hex');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${prefix}-${slug || 'x'}-${hex}`;
}

// ---------------------------------------------------------------------------
// Secrets template resolution (AC-L6-11)
// ---------------------------------------------------------------------------

const SECRETS_TEMPLATE_REGEX = /\{secrets\.([A-Za-z0-9_]+)\}/g;

/**
 * Resolves `{secrets.XXX}` template patterns in a string.
 * Replaces each pattern with the corresponding value from the secrets object.
 * AC-L6-11: Template resolution for container_init and MCP server env.
 *
 * @param value - The string containing `{secrets.XXX}` patterns
 * @param secrets - The secrets object mapping keys to values
 * @returns The resolved string with all patterns replaced
 */
export function resolveSecretsTemplate(value: string, secrets: Record<string, string>): string {
  return value.replace(SECRETS_TEMPLATE_REGEX, (_match, key: string) => {
    if (secrets[key] !== undefined) {
      return secrets[key];
    }
    // Return original pattern if secret not found (allows graceful degradation)
    return `{secrets.${key}}`;
  });
}

/**
 * Recursively resolves `{secrets.XXX}` templates in an object.
 * Walks through all string values and replaces templates.
 */
export function resolveSecretsTemplatesInObject<T>(obj: T, secrets: Record<string, string>): T {
  if (typeof obj === 'string') {
    return resolveSecretsTemplate(obj, secrets) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveSecretsTemplatesInObject(item, secrets)) as T;
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveSecretsTemplatesInObject(value, secrets);
    }
    return result as T;
  }
  return obj;
}
