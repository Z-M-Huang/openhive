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

  it('allows private IP with no allowlist', () => {
    expect(validateBrowserUrl('http://192.168.1.1:8080')).toEqual({ allowed: true });
  });

  it('allows non-http scheme with no allowlist', () => {
    expect(validateBrowserUrl('ftp://files.example.com/data')).toEqual({ allowed: true });
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
