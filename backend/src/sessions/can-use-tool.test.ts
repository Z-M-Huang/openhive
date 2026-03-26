/**
 * UT-8: canUseTool
 *
 * Tests: canUseTool blocks/allows exact, prefix, Bash default deny
 */

import { describe, it, expect } from 'vitest';

import { createCanUseTool } from './can-use-tool.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function captureLog(): { messages: Array<{ msg: string; meta?: Record<string, unknown> }>; logger: { info: (msg: string, meta?: Record<string, unknown>) => void } } {
  const messages: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    messages,
    logger: { info: (msg: string, meta?: Record<string, unknown>) => { messages.push({ msg, meta }); } },
  };
}

const canUseToolOpts = { signal: new AbortController().signal, toolUseID: 'test-tu' };

// ── UT-8: canUseTool ──────────────────────────────────────────────────────

describe('UT-8: canUseTool', () => {
  it('allows exact match', async () => {
    const check = createCanUseTool(['Read', 'Write']);
    expect((await check('Read', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await check('Write', {}, canUseToolOpts)).behavior).toBe('allow');
  });

  it('denies unlisted tools', async () => {
    const check = createCanUseTool(['Read']);
    expect((await check('Edit', {}, canUseToolOpts)).behavior).toBe('deny');
    expect((await check('Grep', {}, canUseToolOpts)).behavior).toBe('deny');
  });

  it('allows prefix match with star', async () => {
    const check = createCanUseTool(['mcp__org__*']);
    expect((await check('mcp__org__escalate', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await check('mcp__org__spawn_team', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await check('mcp__other__tool', {}, canUseToolOpts)).behavior).toBe('deny');
  });

  it('denies Bash by default', async () => {
    const check = createCanUseTool(['Read', 'Write', 'Edit']);
    expect((await check('Bash', {}, canUseToolOpts)).behavior).toBe('deny');
  });

  it('allows Bash if explicitly listed', async () => {
    const check = createCanUseTool(['Read', 'Bash']);
    expect((await check('Bash', {}, canUseToolOpts)).behavior).toBe('allow');
  });

  it('logs denied attempts', async () => {
    const log = captureLog();
    const check = createCanUseTool(['Read'], log.logger);
    await check('Bash', {}, canUseToolOpts);
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0].msg).toContain('denied');
    expect(log.messages[0].meta).toEqual({ tool: 'Bash' });
  });

  it('handles empty allowedTools (deny all)', async () => {
    const check = createCanUseTool([]);
    expect((await check('Read', {}, canUseToolOpts)).behavior).toBe('deny');
    expect((await check('Bash', {}, canUseToolOpts)).behavior).toBe('deny');
  });

  it('mixed exact and prefix entries', async () => {
    const check = createCanUseTool(['Read', 'mcp__org__*', 'Bash']);
    expect((await check('Read', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await check('Bash', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await check('mcp__org__escalate', {}, canUseToolOpts)).behavior).toBe('allow');
    expect((await check('Write', {}, canUseToolOpts)).behavior).toBe('deny');
  });
});
