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

export function validateBrowserUrl(
  url: string,
  allowedDomains?: readonly string[],
): UrlValidationResult {
  // No allowlist = all allowed
  if (!allowedDomains || allowedDomains.length === 0) {
    return { allowed: true };
  }

  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return { allowed: false, reason: 'invalid URL' };
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
