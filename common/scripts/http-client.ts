#!/usr/bin/env bun
/**
 * HTTP Client with timeout, retry, and SSRF protection.
 *
 * Usage:
 *   bun run http-client.ts <url> [--method GET|POST|PUT|DELETE] [--data <json>] [--timeout 10000] [--allow-http]
 *
 * Security features:
 * - HTTPS-only by default (--allow-http to enable)
 * - Blocks private IP ranges
 * - Validates redirect destinations
 * - DNS resolution validation
 */

import { parseArgs } from 'util';

// Private IP ranges to block
const PRIVATE_IP_RANGES = [
  { prefix: '10.0.0.0', mask: 8 },
  { prefix: '172.16.0.0', mask: 12 },
  { prefix: '192.168.0.0', mask: 16 },
  { prefix: '127.0.0.0', mask: 8 },
  { prefix: '169.254.169.254', mask: 32 }, // AWS metadata
];

interface CliArgs {
  url: string;
  method: string;
  data?: string;
  timeout: number;
  allowHttp: boolean;
}

function parseCliArgs(): CliArgs {
  const { values, positionals } = parseArgs({
    options: {
      method: { type: 'string', default: 'GET' },
      data: { type: 'string' },
      timeout: { type: 'string', default: '10000' },
      'allow-http': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });

  if (positionals.length < 1) {
    console.error('Usage: bun run http-client.ts <url> [--method GET|POST|PUT|DELETE] [--data <json>] [--timeout 10000] [--allow-http]');
    process.exit(1);
  }

  return {
    url: positionals[0] as string,
    method: values.method as string,
    data: values.data as string | undefined,
    timeout: parseInt(values.timeout as string, 10),
    allowHttp: values['allow-http'] as boolean,
  };
}

function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/** IPv6 addresses that must be blocked for SSRF protection. */
const PRIVATE_IPV6_PREFIXES = [
  '::1',       // loopback
  '::ffff:',   // IPv4-mapped IPv6
  'fe80:',     // link-local
  'fc00:',     // unique local (fc00::/7 covers fc00:: and fd00::)
  'fd00:',     // unique local
  '::',        // unspecified (block when exactly "::")
];

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  for (const prefix of PRIVATE_IPV6_PREFIXES) {
    if (lower.startsWith(prefix)) return true;
  }
  return false;
}

function isPrivateIP(ip: string): boolean {
  // Check IPv6 first
  if (ip.includes(':')) {
    return isPrivateIPv6(ip);
  }

  const ipNum = ipToNumber(ip);

  for (const range of PRIVATE_IP_RANGES) {
    const prefixNum = ipToNumber(range.prefix);
    const mask = range.mask;

    if (mask === 32) {
      if (ipNum === prefixNum) return true;
    } else {
      const maskNum = (~((1 << (32 - mask)) - 1)) >>> 0;
      if ((ipNum & maskNum) === (prefixNum & maskNum)) return true;
    }
  }

  return false;
}

function isLiteralIP(hostname: string): boolean {
  // IPv6 literal (bracketed or raw) or IPv4 dotted-decimal
  return hostname.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
}

async function resolveHostname(hostname: string): Promise<string[]> {
  // Literal IPs don't need DNS resolution — validate directly
  if (isLiteralIP(hostname)) {
    return [hostname.replace(/^\[|\]$/g, '')];
  }

  const dns = await import('dns');
  const { promisify } = await import('util');

  const resolve4 = promisify(dns.resolve4);
  const resolve6 = promisify(dns.resolve6);

  // Resolve BOTH families and validate all addresses
  const addresses: string[] = [];

  try {
    const v4 = await resolve4(hostname);
    addresses.push(...v4);
  } catch { /* no A records */ }

  try {
    const v6 = await resolve6(hostname);
    addresses.push(...v6);
  } catch { /* no AAAA records */ }

  if (addresses.length === 0) {
    throw new Error('DNS resolution failed: no addresses found');
  }

  return addresses;
}

async function validateUrl(urlString: string, allowHttp: boolean): Promise<URL> {
  let url: URL;

  try {
    url = new URL(urlString);
  } catch {
    throw new Error('Invalid URL format');
  }

  const protocol = url.protocol.toLowerCase();

  if (!allowHttp && protocol !== 'https:') {
    throw new Error('HTTP is not allowed. Use --allow-http flag to enable.');
  }

  if (protocol !== 'http:' && protocol !== 'https:') {
    throw new Error('Only http and https protocols are allowed');
  }

  // Check if hostname resolves to private IP
  const addresses = await resolveHostname(url.hostname);
  for (const ip of addresses) {
    if (isPrivateIP(ip)) {
      throw new Error(`Request blocked: hostname resolves to private IP (${ip})`);
    }
  }

  return url;
}

async function fetchWithTimeout(
  url: string,
  options: RequestInit & { timeout: number }
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'manual', // Handle redirects manually for security
    });

    // Check for redirect to private IP
    if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
      const location = response.headers.get('location');
      if (location) {
        try {
          const redirectUrl = new URL(location, url);
          const redirectAddresses = await resolveHostname(redirectUrl.hostname);

          for (const ip of redirectAddresses) {
            if (isPrivateIP(ip)) {
              throw new Error('Redirect to private IP blocked');
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.includes('private IP')) {
            throw err;
          }
          // If redirect URL parsing fails, block it
          throw new Error('Invalid redirect URL');
        }
      }
    }

    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWithRetry(
  url: string,
  options: RequestInit & { timeout: number },
  maxRetries: number = 3
): Promise<Response> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetchWithTimeout(url, options);

      // Retry on 5xx errors
      if (response.status >= 500 && attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 * (0.8 + Math.random() * 0.4); // Exponential backoff with 20% jitter
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      return response;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      // Don't retry on network errors that aren't transient
      if (err instanceof Error && (
        err.message.includes('blocked') ||
        err.message.includes('private IP') ||
        err.message.includes('Invalid URL')
      )) {
        throw err;
      }

      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt) * 1000 * (0.8 + Math.random() * 0.4);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

async function main() {
  const args = parseCliArgs();

  try {
    // Validate URL (inside try to catch validation/DNS errors as JSON)
    const url = await validateUrl(args.url, args.allowHttp);

    // Build fetch options
    const fetchOptions: RequestInit & { timeout: number } = {
      method: args.method,
      timeout: args.timeout,
      headers: {
        'User-Agent': 'OpenHive-HTTP-Client/1.0',
      },
    };

    if (args.data) {
      try {
        JSON.parse(args.data); // Validate JSON
        fetchOptions.body = args.data;
        fetchOptions.headers = {
          ...fetchOptions.headers,
          'Content-Type': 'application/json',
        };
      } catch {
        console.error(JSON.stringify({ status: 'error', error: '--data must be valid JSON' }));
        process.exit(1);
      }
    }

    const response = await fetchWithRetry(url.toString(), fetchOptions);

    // Handle redirect
    if (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308) {
      const location = response.headers.get('location');
      console.log(JSON.stringify({
        status: 'redirect',
        statusCode: response.status,
        location: location,
      }));
      return;
    }

    // Get response body
    const contentType = response.headers.get('content-type') || '';
    let body: unknown;

    if (contentType.includes('application/json')) {
      body = await response.json();
    } else {
      body = await response.text();
    }

    console.log(JSON.stringify({
      status: 'ok',
      statusCode: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: body,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      status: 'error',
      error: message,
    }));
    process.exit(1);
  }
}

main();