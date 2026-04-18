/**
 * Validation schema tests.
 *
 * Post-Bug #2: TriggerEntrySchema no longer carries a `skill` field. Skills
 * are owned by the subagent (`## Skills` section, per ADR-40); the trigger
 * names the subagent and nothing else.
 *
 * AC-15.4: stepCountIs source (config-parse time) rejects invalid types.
 */

import { describe, it, expect } from 'vitest';
import { TriggerEntrySchema, TeamConfigSchema } from './validation.js';

const base = {
  name: 't',
  type: 'schedule' as const,
  team: 'ops',
  task: 'do thing',
  config: { cron: '* * * * *' },
};

describe('TriggerEntrySchema', () => {
  it('accepts subagent alone', () => {
    const result = TriggerEntrySchema.safeParse({ ...base, subagent: 'a' });
    expect(result.success).toBe(true);
  });

  it('accepts neither subagent nor any skill field', () => {
    const result = TriggerEntrySchema.safeParse(base);
    expect(result.success).toBe(true);
  });
});

describe('TeamConfigSchema maxSteps type validation (AC-15.4)', () => {
  it('rejects string maxSteps', () => {
    const result = TeamConfigSchema.safeParse({
      name: 't',
      provider_profile: 'p',
      maxSteps: 'fifty',
    });
    expect(result.success).toBe(false);
  });

  it('rejects boolean maxSteps', () => {
    const result = TeamConfigSchema.safeParse({
      name: 't',
      provider_profile: 'p',
      maxSteps: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects null maxSteps', () => {
    const result = TeamConfigSchema.safeParse({
      name: 't',
      provider_profile: 'p',
      maxSteps: null,
    });
    expect(result.success).toBe(false);
  });
});
