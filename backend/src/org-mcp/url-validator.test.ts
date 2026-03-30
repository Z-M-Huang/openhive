import { describe, it, expect } from 'vitest';
import { validateBrowserUrl } from './url-validator.js';

describe('URL Validator: validateBrowserUrl', () => {
  it('allows all URLs when allowedDomains is undefined', () => {
    expect(validateBrowserUrl('https://example.com')).toEqual({ allowed: true });
  });

  it('allows all URLs when allowedDomains is empty array', () => {
    expect(validateBrowserUrl('https://example.com', [])).toEqual({ allowed: true });
  });

  it('allows exact domain match', () => {
    const result = validateBrowserUrl('https://example.com/path', ['example.com']);
    expect(result).toEqual({ allowed: true });
  });

  it('allows glob pattern match (*.example.com)', () => {
    const result = validateBrowserUrl('https://sub.example.com', ['*.example.com']);
    expect(result).toEqual({ allowed: true });
  });

  it('glob *.example.com does NOT match example.com itself', () => {
    const result = validateBrowserUrl('https://example.com', ['*.example.com']);
    expect(result.allowed).toBe(false);
  });

  it('blocks domain not in allowlist', () => {
    const result = validateBrowserUrl('https://evil.com', ['example.com']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('evil.com');
  });

  it('blocks private IPs even with no allowlist (SSRF protection)', () => {
    expect(validateBrowserUrl('http://192.168.1.1:8080').allowed).toBe(false);
    expect(validateBrowserUrl('http://10.0.0.1').allowed).toBe(false);
    expect(validateBrowserUrl('http://127.0.0.1:8080/health').allowed).toBe(false);
    expect(validateBrowserUrl('http://169.254.169.254/latest/meta-data/').allowed).toBe(false);
    expect(validateBrowserUrl('http://localhost:3000').allowed).toBe(false);
    expect(validateBrowserUrl('http://0.0.0.0').allowed).toBe(false);
  });

  it('blocks IPv6 loopback and private addresses', () => {
    expect(validateBrowserUrl('http://[::1]/').allowed).toBe(false);
    expect(validateBrowserUrl('http://[::ffff:127.0.0.1]/').allowed).toBe(false);
    expect(validateBrowserUrl('http://[fe80::1]/').allowed).toBe(false);
    expect(validateBrowserUrl('http://[fc00::1]/').allowed).toBe(false);
    expect(validateBrowserUrl('http://[fd00::1]/').allowed).toBe(false);
  });

  it('blocks IPv4-mapped IPv6 private addresses', () => {
    expect(validateBrowserUrl('http://[::ffff:10.0.0.1]/').allowed).toBe(false);
    expect(validateBrowserUrl('http://[::ffff:192.168.1.1]/').allowed).toBe(false);
    expect(validateBrowserUrl('http://[::ffff:172.16.0.1]/').allowed).toBe(false);
  });

  it('blocks localhost with trailing dot', () => {
    expect(validateBrowserUrl('http://localhost.:8080').allowed).toBe(false);
  });

  it('blocks file:// scheme', () => {
    const result = validateBrowserUrl('file:///etc/passwd');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('scheme');
  });

  it('blocks ftp:// and other non-http schemes', () => {
    expect(validateBrowserUrl('ftp://files.example.com/data').allowed).toBe(false);
    expect(validateBrowserUrl('gopher://example.com').allowed).toBe(false);
  });

  it('rejects invalid URL', () => {
    const result = validateBrowserUrl('not-a-url', ['example.com']);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('invalid URL');
  });

  it('matches any one of multiple allowed_domains', () => {
    const domains = ['example.com', '*.internal.io'];
    expect(validateBrowserUrl('https://example.com', domains).allowed).toBe(true);
    expect(validateBrowserUrl('https://app.internal.io', domains).allowed).toBe(true);
    expect(validateBrowserUrl('https://other.com', domains).allowed).toBe(false);
  });

  it('allows deep subdomain with glob pattern', () => {
    const result = validateBrowserUrl('https://a.b.c.example.com', ['*.example.com']);
    expect(result).toEqual({ allowed: true });
  });
});
