/**
 * URL domain allowlist validator for browser tools.
 *
 * When allowed_domains is specified, only URLs whose hostname matches
 * a pattern in the list are permitted. Supports exact matches and
 * glob patterns (*.example.com).
 *
 * When allowed_domains is undefined or empty, all URLs are allowed.
 */

export interface UrlValidationResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * Parse a hex-encoded IPv4-mapped IPv6 address (::ffff:XXYY:ZZWW) back to
 * dotted-quad so we can reuse the same private-range regex. Returns undefined
 * if the address is not IPv4-mapped hex form.
 */
function ipv4MappedToQuad(h: string): string | undefined {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(h);
  if (!m) return undefined;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

/** Returns true when the hostname is a private/reserved IP or loopback address. */
function isPrivateHost(hostname: string): boolean {
  // Node keeps brackets on IPv6 hostnames — strip them
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // Loopback (incl. trailing-dot variant)
  if (h === 'localhost' || h === 'localhost.' || h === '127.0.0.1' || h === '::1') return true;
  // AWS/GCP metadata
  if (h === '169.254.169.254') return true;
  // RFC1918 / RFC6598 ranges — quick prefix check on dotted-quad
  if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(h)) return true;
  // Link-local 169.254.x.x
  if (h.startsWith('169.254.')) return true;
  // IPv6 private/reserved (fe80::, fc00::, fd00::)
  if (/^(fe80|fc00|fd[0-9a-f]{2})::/i.test(h)) return true;
  // 0.0.0.0
  if (h === '0.0.0.0') return true;
  // IPv4-mapped IPv6 hex form (::ffff:XXYY:ZZWW) — Node converts dotted-quad to hex
  const quad = ipv4MappedToQuad(h);
  if (quad) return isPrivateHost(quad);
  // Dotted-quad form of IPv4-mapped (::ffff:127.0.0.1)
  if (h.startsWith('::ffff:')) return isPrivateHost(h.slice(7));
  return false;
}

export function validateBrowserUrl(
  url: string,
  allowedDomains?: readonly string[],
): UrlValidationResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: false, reason: 'invalid URL' };
  }

  // Scheme gate: only http/https allowed
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { allowed: false, reason: `blocked: scheme ${parsed.protocol} not allowed` };
  }

  const hostname = parsed.hostname;

  // SSRF protection: always block private/reserved IPs regardless of allowlist
  if (isPrivateHost(hostname)) {
    return { allowed: false, reason: `blocked: private/reserved address ${hostname}` };
  }

  // No allowlist = all public URLs allowed
  if (!allowedDomains || allowedDomains.length === 0) {
    return { allowed: true };
  }

  for (const domain of allowedDomains) {
    if (domain.startsWith('*.')) {
      // Glob: *.example.com matches sub.example.com but not example.com itself
      const suffix = domain.slice(1); // ".example.com"
      if (hostname.endsWith(suffix) && hostname.length > suffix.length) {
        return { allowed: true };
      }
    } else if (hostname === domain) {
      return { allowed: true };
    }
  }

  return { allowed: false, reason: `domain not in allowlist: ${hostname}` };
}
