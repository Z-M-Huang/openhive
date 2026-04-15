/**
 * Active Tools Resolution — unit tests.
 *
 * Tests resolveActiveTools: wildcard '*', exact match,
 * glob prefix matching, and edge cases.
 */

import { describe, it, expect } from 'vitest';

import { resolveActiveTools } from './active-tools.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

const ALL_TOOLS = [
  'Bash',
  'Edit',
  'Glob',
  'Grep',
  'Read',
  'Write',
  'delegate_task',
  'escalate',
  'spawn_team',
  'browser_click',
  'browser_screenshot',
];

// ── Tests ────────────────────────────────────────────────────────────────────

describe('resolveActiveTools', () => {
  it('wildcard "*" returns all tools', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['*']);
    expect(result).toEqual(ALL_TOOLS);
  });

  it('exact match returns only matched tools', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['Read', 'Write']);
    expect(result).toEqual(['Read', 'Write']);
  });

  it('glob prefix "browser_*" matches all browser tools', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['browser_*']);
    expect(result).toEqual([
      'browser_click',
      'browser_screenshot',
    ]);
  });

  it('glob prefix with underscores matches tool namespace', () => {
    // 'delegate_*' matches any tool starting with 'delegate_'.
    const result = resolveActiveTools(ALL_TOOLS, ['delegate_*']);
    expect(result).toEqual(['delegate_task']);
  });

  it('combines exact matches and glob prefixes', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['Read', 'browser_*']);
    expect(result).toEqual([
      'Read',
      'browser_click',
      'browser_screenshot',
    ]);
  });

  it('returns empty array when no tools match', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['nonexistent_tool']);
    expect(result).toEqual([]);
  });

  it('returns empty array when allowed_tools is empty', () => {
    const result = resolveActiveTools(ALL_TOOLS, []);
    expect(result).toEqual([]);
  });

  it('returns empty array when allToolNames is empty', () => {
    const result = resolveActiveTools([], ['*']);
    expect(result).toEqual([]);
  });

  it('preserves original order of allToolNames', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['Write', 'Read', 'Bash']);
    // Should follow ALL_TOOLS order, not allowed_tools order
    expect(result).toEqual(['Bash', 'Read', 'Write']);
  });

  it('does not duplicate tools matched by both exact and glob', () => {
    const result = resolveActiveTools(ALL_TOOLS, [
      'browser_click',
      'browser_*',
    ]);
    // browser_click appears in both exact and prefix — should not be duplicated
    const clickCount = result.filter((n) => n === 'browser_click').length;
    expect(clickCount).toBe(1);
  });
});
