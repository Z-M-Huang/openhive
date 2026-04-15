/**
 * Validation schema tests for ADR-40 compliance.
 *
 * AC-6: TriggerEntrySchema rejects skill without subagent.
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

describe('TriggerEntrySchema ADR-40 refine', () => {
  it('rejects skill without subagent', () => {
    const result = TriggerEntrySchema.safeParse({ ...base, skill: 's' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message.toLowerCase()).toContain('adr-40');
    }
  });

  it('accepts skill with subagent', () => {
    const result = TriggerEntrySchema.safeParse({ ...base, skill: 's', subagent: 'a' });
    expect(result.success).toBe(true);
  });

  it('accepts subagent alone', () => {
    const result = TriggerEntrySchema.safeParse({ ...base, subagent: 'a' });
    expect(result.success).toBe(true);
  });

  it('accepts neither skill nor subagent', () => {
    const result = TriggerEntrySchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it('rejects empty-string subagent combined with skill', () => {
    const result = TriggerEntrySchema.safeParse({ ...base, skill: 's', subagent: '' });
    expect(result.success).toBe(false);
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
