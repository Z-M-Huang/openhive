import { describe, it, expect } from 'vitest';
import { scanPluginSource } from './plugin-security.js';

describe('scanPluginSource', () => {
  it('returns passed:false when source contains a detected secret pattern', () => {
    const result = scanPluginSource('const key = "AKIAIOSFODNN7EXAMPLE";');
    expect(result.passed).toBe(false);
    expect(result.detectedSecrets.length).toBeGreaterThan(0);
  });
  it('returns passed:true when source is clean', () => {
    const result = scanPluginSource('export const x = 42;');
    expect(result.passed).toBe(true);
  });
});
