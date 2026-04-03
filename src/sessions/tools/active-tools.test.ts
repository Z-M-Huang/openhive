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
  'mcp__org__delegate_task',
  'mcp__org__escalate',
  'mcp__org__spawn_team',
  'mcp__browser__click',
  'mcp__browser__screenshot',
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

  it('glob prefix "mcp__org__*" matches all org tools', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['mcp__org__*']);
    expect(result).toEqual([
      'mcp__org__delegate_task',
      'mcp__org__escalate',
      'mcp__org__spawn_team',
    ]);
  });

  it('glob prefix "mcp__browser__*" matches all browser tools', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['mcp__browser__*']);
    expect(result).toEqual([
      'mcp__browser__click',
      'mcp__browser__screenshot',
    ]);
  });

  it('combines exact matches and glob prefixes', () => {
    const result = resolveActiveTools(ALL_TOOLS, ['Read', 'mcp__org__*']);
    expect(result).toEqual([
      'Read',
      'mcp__org__delegate_task',
      'mcp__org__escalate',
      'mcp__org__spawn_team',
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
      'mcp__org__escalate',
      'mcp__org__*',
    ]);
    // mcp__org__escalate appears in both exact and prefix — should not be duplicated
    const escalateCount = result.filter((n) => n === 'mcp__org__escalate').length;
    expect(escalateCount).toBe(1);
  });
});
