import { describe, it, expect } from 'vitest';
import { buildUseSkillTool } from './skill-tools.js';
import type { SubagentDefinition } from '../skill-loader.js';

function makeDef(skills: Array<{ name: string; content: string; requiredTools?: string[] }>): SubagentDefinition {
  return {
    description: 'test',
    prompt: 'You are a test subagent',
    skills: skills.map((s) => s.name),
    resolvedSkills: skills.map((s) => ({
      name: s.name,
      content: s.content,
      requiredTools: s.requiredTools ?? [],
    })),
  };
}

function invoke(t: ReturnType<typeof buildUseSkillTool>, skillName: string) {
  const rec = t.use_skill as unknown as { execute: (args: { skill_name: string }) => Promise<unknown> };
  return rec.execute({ skill_name: skillName });
}

describe('buildUseSkillTool', () => {
  it('returns the skill body on a valid skill_name', async () => {
    const def = makeDef([
      { name: 'monitor_loggly', content: '# Monitor Loggly\nSteps: fetch, analyze.' },
    ]);
    const res = await invoke(buildUseSkillTool(def, 'ops-team'), 'monitor_loggly');
    expect(res).toEqual({ body: '# Monitor Loggly\nSteps: fetch, analyze.' });
  });

  it('returns an error envelope naming available skills when skill not declared', async () => {
    const def = makeDef([
      { name: 'monitor_loggly', content: 'x' },
      { name: 'rotate_keys', content: 'y' },
    ]);
    const res = (await invoke(buildUseSkillTool(def, 'ops-team'), 'nope')) as { error: string };
    expect(res.error).toContain('skill "nope" not declared');
    expect(res.error).toContain('monitor_loggly');
    expect(res.error).toContain('rotate_keys');
  });

  it('returns a clear error when the subagent has no skills', async () => {
    const def: SubagentDefinition = { description: '', prompt: '', skills: [], resolvedSkills: [] };
    const res = (await invoke(buildUseSkillTool(def, 'ops-team'), 'anything')) as { error: string };
    expect(res.error).toContain('(none)');
  });
});

describe('buildUseSkillTool — namespacing rewrites bare plugin refs', () => {
  it('rewrites bare references to required tools into <team>.<tool>', async () => {
    const def = makeDef([
      {
        name: 'monitor_loggly',
        requiredTools: ['fetch_loggly_logs', 'analyze_logs'],
        content: [
          '## Required Tools',
          '- fetch_loggly_logs',
          '- analyze_logs',
          '',
          '## Steps',
          '1. Call `fetch_loggly_logs` with creds.',
          '2. Pass output to `analyze_logs`.',
        ].join('\n'),
      },
    ]);
    const res = (await invoke(buildUseSkillTool(def, 'ops-team'), 'monitor_loggly')) as { body: string };
    expect(res.body).toContain('- ops-team.fetch_loggly_logs');
    expect(res.body).toContain('- ops-team.analyze_logs');
    expect(res.body).toContain('Call `ops-team.fetch_loggly_logs` with creds');
    expect(res.body).toContain('Pass output to `ops-team.analyze_logs`');
    // Sanity: no bare reference survives
    expect(res.body).not.toMatch(/(?<![.\w])fetch_loggly_logs(?![\w])/);
    expect(res.body).not.toMatch(/(?<![.\w])analyze_logs(?![\w])/);
  });

  it('does not double-namespace already-prefixed references', async () => {
    const def = makeDef([
      {
        name: 's',
        requiredTools: ['fetch_loggly_logs'],
        content: 'Call `ops-team.fetch_loggly_logs` directly.',
      },
    ]);
    const res = (await invoke(buildUseSkillTool(def, 'ops-team'), 's')) as { body: string };
    expect(res.body).toBe('Call `ops-team.fetch_loggly_logs` directly.');
    expect(res.body).not.toContain('ops-team.ops-team.');
  });

  it('does not rewrite substrings of longer identifiers', async () => {
    const def = makeDef([
      {
        name: 's',
        requiredTools: ['fetch_logs'],
        content: 'Helper my_fetch_logs_wrapper exists. Call fetch_logs to start.',
      },
    ]);
    const res = (await invoke(buildUseSkillTool(def, 'ops-team'), 's')) as { body: string };
    expect(res.body).toContain('my_fetch_logs_wrapper');
    expect(res.body).toContain('Call ops-team.fetch_logs to start');
    expect(res.body).not.toContain('my_ops-team.fetch_logs_wrapper');
  });

  it('returns content unchanged when requiredTools is empty', async () => {
    const def = makeDef([
      {
        name: 's',
        requiredTools: [],
        content: 'Mention fetch_loggly_logs but no rewrite expected.',
      },
    ]);
    const res = (await invoke(buildUseSkillTool(def, 'ops-team'), 's')) as { body: string };
    expect(res.body).toBe('Mention fetch_loggly_logs but no rewrite expected.');
  });
});
