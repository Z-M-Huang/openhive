/**
 * Unit 6: System Prompt Builder
 *
 * Tests that buildSystemPrompt assembles all sections correctly
 * and omits optional sections when their inputs are empty.
 */

import { describe, it, expect } from 'vitest';

import {
  buildSystemPrompt,
  buildToolAvailabilityNote,
  type PromptBuilderOpts,
} from './prompt-builder.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeOpts(overrides?: Partial<PromptBuilderOpts>): PromptBuilderOpts {
  return {
    teamName: 'test-team',
    allowedTools: ['*'],
    credentialKeys: [],
    ruleCascade: '',
    skillsContent: '',
    memorySection: '',
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Unit 6: System Prompt Builder', () => {
  it('includes core instructions', () => {
    const prompt = buildSystemPrompt(makeOpts());
    expect(prompt).toContain('You are an AI agent team member in the OpenHive system');
  });

  it('includes tool availability when allowed_tools=["*"]', () => {
    const prompt = buildSystemPrompt(makeOpts({ allowedTools: ['*'] }));
    expect(prompt).toContain('--- Tool Availability for This Team ---');
    expect(prompt).toContain('All tools are ENABLED for this team');
  });

  it('includes per-tool ENABLED/DISABLED when allowed_tools is selective', () => {
    const prompt = buildSystemPrompt(makeOpts({ allowedTools: ['Read', 'Write'] }));
    expect(prompt).toContain('- **Read** — ENABLED');
    expect(prompt).toContain('- **Write** — ENABLED');
    expect(prompt).toContain('- **Bash** — DISABLED');
    expect(prompt).toContain('- **Grep** — DISABLED');
  });

  it('includes credential note when keys present', () => {
    const prompt = buildSystemPrompt(makeOpts({ credentialKeys: ['GITHUB_TOKEN', 'SLACK_KEY'] }));
    expect(prompt).toContain('## Available Credentials');
    expect(prompt).toContain('`GITHUB_TOKEN`');
    expect(prompt).toContain('`SLACK_KEY`');
    expect(prompt).toContain('get_credential({ key: "KEY_NAME" })');
  });

  it('omits credential note when no keys', () => {
    const prompt = buildSystemPrompt(makeOpts({ credentialKeys: [] }));
    expect(prompt).not.toContain('## Available Credentials');
  });

  it('includes rule cascade', () => {
    const rules = '## Team Rules\n- Always respond in English\n- Never delete production data';
    const prompt = buildSystemPrompt(makeOpts({ ruleCascade: rules }));
    expect(prompt).toContain('## Team Rules');
    expect(prompt).toContain('Always respond in English');
  });

  it('includes skills content', () => {
    const skills = '## Skills\n- deploy: Deploy the application\n- rollback: Rollback deployment';
    const prompt = buildSystemPrompt(makeOpts({ skillsContent: skills }));
    expect(prompt).toContain('## Skills');
    expect(prompt).toContain('deploy: Deploy the application');
  });

  it('includes memory section', () => {
    const memory = '## Memory\n- Last deployment: 2026-03-28 at 14:00 UTC';
    const prompt = buildSystemPrompt(makeOpts({ memorySection: memory }));
    expect(prompt).toContain('## Memory');
    expect(prompt).toContain('Last deployment: 2026-03-28');
  });

  it('includes HTTP rules', () => {
    const prompt = buildSystemPrompt(makeOpts());
    expect(prompt).toContain('## HTTP Request Rules');
    expect(prompt).toContain('--connect-timeout 10 --max-time 60');
    expect(prompt).toContain('2 attempts max for auth failures');
  });

  it('includes tool usage guide', () => {
    const prompt = buildSystemPrompt(makeOpts());
    expect(prompt).toContain('## Available Built-in Tools');
    expect(prompt).toContain('**Read** — Read a file');
    expect(prompt).toContain('**Bash** — Execute a shell command');
    expect(prompt).toContain('**Glob** — Find files matching a pattern');
  });
});

describe('buildToolAvailabilityNote', () => {
  it('wildcard glob patterns match tool prefixes', () => {
    // A pattern like "Re*" should match "Read"
    const note = buildToolAvailabilityNote(['Re*', 'Bash']);
    expect(note).toContain('- **Read** — ENABLED');
    expect(note).toContain('- **Bash** — ENABLED');
    expect(note).toContain('- **Write** — DISABLED');
  });
});
