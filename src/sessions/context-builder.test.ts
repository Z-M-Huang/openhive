/**
 * UT-7: Context Builder
 *
 * Tests: Context builder produces correct cwd and additionalDirectories
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

import { buildSessionContext } from './context-builder.js';

// ── UT-7: Context Builder ─────────────────────────────────────────────────

describe('UT-7: Context Builder', () => {
  it('produces correct cwd', () => {
    const ctx = buildSessionContext('weather-team', '/run');
    expect(ctx.cwd).toBe(join('/run', 'teams', 'weather-team'));
  });

  it('produces empty additionalDirectories', () => {
    const ctx = buildSessionContext('weather-team', '/run');
    expect(ctx.additionalDirectories).toEqual([]);
  });
});
