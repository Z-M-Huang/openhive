import { describe, it, expect } from 'vitest';
import { buildTriggerTaskOptions } from './task-options.js';

describe('buildTriggerTaskOptions', () => {
  it('returns undefined when entry is undefined and no override', () => {
    expect(buildTriggerTaskOptions(undefined)).toBeUndefined();
  });

  it('returns undefined when entry has neither field and no override', () => {
    expect(buildTriggerTaskOptions({})).toBeUndefined();
  });

  it('emits only maxSteps when only maxSteps is set', () => {
    expect(buildTriggerTaskOptions({ maxSteps: 50 })).toEqual({ maxSteps: 50 });
  });

  it('emits only subagent when only subagent is set', () => {
    expect(buildTriggerTaskOptions({ subagent: 'log-monitor' })).toEqual({ subagent: 'log-monitor' });
  });

  it('emits both fields when both are set', () => {
    expect(buildTriggerTaskOptions({ maxSteps: 100, subagent: 'log-monitor' })).toEqual({
      maxSteps: 100,
      subagent: 'log-monitor',
    });
  });

  it('override wins over entry.maxSteps', () => {
    expect(buildTriggerTaskOptions({ maxSteps: 50, subagent: 'x' }, 200)).toEqual({
      maxSteps: 200,
      subagent: 'x',
    });
  });

  it('override applies when entry has no maxSteps', () => {
    expect(buildTriggerTaskOptions({ subagent: 'x' }, 200)).toEqual({
      maxSteps: 200,
      subagent: 'x',
    });
  });

  it('override applies when entry is undefined', () => {
    expect(buildTriggerTaskOptions(undefined, 200)).toEqual({ maxSteps: 200 });
  });
});
