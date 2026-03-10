/**
 * Tests for SkillRegistryImpl (skill-registry.ts).
 *
 * Covers:
 *   - Interface conformance
 *   - install from direct URL writes SKILL.md to workspace
 *   - install from registry by name writes SKILL.md to workspace
 *   - install throws when no name or url provided
 *   - install throws when fetch fails
 *   - install throws when no registry configured
 *   - install extracts name from YAML frontmatter
 *   - search queries registries and aggregates results
 *   - search handles registry errors gracefully
 *   - listRegistries returns configured URLs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SkillRegistryImpl, type SkillRegistryDeps } from './skill-registry.js';
import type { SkillRegistry } from '../domain/interfaces.js';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): SkillRegistryDeps['logger'] {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

/**
 * Creates a mock fetch function with configurable responses.
 */
function makeMockFetch(responses: Map<string, { ok: boolean; status: number; body: string }>): typeof fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const resp = responses.get(url);
    if (resp === undefined) {
      return new Response('Not found', { status: 404, statusText: 'Not Found' });
    }
    return new Response(resp.body, {
      status: resp.status,
      statusText: resp.ok ? 'OK' : 'Error',
      headers: { 'Content-Type': resp.body.startsWith('{') ? 'application/json' : 'text/markdown' },
    });
  };
}

const SAMPLE_SKILL = `---
name: email-monitor
description: "Monitors email inbox"
---
This skill monitors the email inbox for new messages.
`;

// ---------------------------------------------------------------------------
// Interface conformance
// ---------------------------------------------------------------------------

describe('SkillRegistryImpl interface conformance', () => {
  it('satisfies the SkillRegistry interface', () => {
    const registry: SkillRegistry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
    });
    expect(typeof registry.install).toBe('function');
    expect(typeof registry.search).toBe('function');
    expect(typeof registry.listRegistries).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

describe('install', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openhive-skill-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('installs from direct URL and writes SKILL.md', async () => {
    const responses = new Map([
      ['https://example.com/my-skill/SKILL.md', { ok: true, status: 200, body: SAMPLE_SKILL }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
      fetchFn: makeMockFetch(responses),
    });

    const name = await registry.install({ url: 'https://example.com/my-skill/SKILL.md' }, tmpDir);
    expect(name).toBe('email-monitor');

    const content = await readFile(join(tmpDir, '.claude', 'skills', 'email-monitor', 'SKILL.md'), 'utf-8');
    expect(content).toBe(SAMPLE_SKILL);
  });

  it('installs from registry by name', async () => {
    const responses = new Map([
      ['https://clawhub.ai/skills/email-monitor/SKILL.md', { ok: true, status: 200, body: SAMPLE_SKILL }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills'],
      logger: makeLogger(),
      fetchFn: makeMockFetch(responses),
    });

    const name = await registry.install({ name: 'email-monitor' }, tmpDir);
    expect(name).toBe('email-monitor');

    const content = await readFile(join(tmpDir, '.claude', 'skills', 'email-monitor', 'SKILL.md'), 'utf-8');
    expect(content).toBe(SAMPLE_SKILL);
  });

  it('uses provided name as fallback when frontmatter has no name', async () => {
    const noNameSkill = `---
description: "A skill without name"
---
Body content here.
`;
    const responses = new Map([
      ['https://example.com/skill.md', { ok: true, status: 200, body: noNameSkill }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
      fetchFn: makeMockFetch(responses),
    });

    const name = await registry.install({ url: 'https://example.com/skill.md', name: 'my-custom-skill' }, tmpDir);
    expect(name).toBe('my-custom-skill');
  });

  it('throws when no name or url provided', async () => {
    const registry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
    });

    await expect(
      registry.install({}, tmpDir),
    ).rejects.toThrow(ValidationError);
  });

  it('throws when fetch fails for direct URL', async () => {
    const responses = new Map([
      ['https://example.com/bad.md', { ok: false, status: 404, body: 'Not found' }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
      fetchFn: makeMockFetch(responses),
    });

    await expect(
      registry.install({ url: 'https://example.com/bad.md' }, tmpDir),
    ).rejects.toThrow(ValidationError);
  });

  it('throws when no registry configured and name provided', async () => {
    const registry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
    });

    await expect(
      registry.install({ name: 'some-skill' }, tmpDir),
    ).rejects.toThrow(ValidationError);
  });

  it('throws when skill not found in registry', async () => {
    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills'],
      logger: makeLogger(),
      fetchFn: makeMockFetch(new Map()),  // empty — will return 404
    });

    await expect(
      registry.install({ name: 'nonexistent-skill' }, tmpDir),
    ).rejects.toThrow(ValidationError);
  });

  it('warns when registry frontmatter name differs from requested name', async () => {
    const warnings: string[] = [];
    const warnLogger = {
      info: () => undefined,
      warn: (msg: string) => { warnings.push(msg); },
      error: () => undefined,
    };

    // SAMPLE_SKILL has name: email-monitor in frontmatter
    const responses = new Map([
      ['https://clawhub.ai/skills/my-alias/SKILL.md', { ok: true, status: 200, body: SAMPLE_SKILL }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills'],
      logger: warnLogger,
      fetchFn: makeMockFetch(responses),
    });

    const name = await registry.install({ name: 'my-alias' }, tmpDir);
    // Uses the requested name, not frontmatter name
    expect(name).toBe('my-alias');
    // But warns about the mismatch
    expect(warnings).toContain('skill frontmatter name mismatch');
  });

  it('does not warn when registry frontmatter name matches requested name', async () => {
    const warnings: string[] = [];
    const warnLogger = {
      info: () => undefined,
      warn: (msg: string) => { warnings.push(msg); },
      error: () => undefined,
    };

    const responses = new Map([
      ['https://clawhub.ai/skills/email-monitor/SKILL.md', { ok: true, status: 200, body: SAMPLE_SKILL }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills'],
      logger: warnLogger,
      fetchFn: makeMockFetch(responses),
    });

    await registry.install({ name: 'email-monitor' }, tmpDir);
    expect(warnings).not.toContain('skill frontmatter name mismatch');
  });

  it('uses specified registry URL when it is in the configured allowlist', async () => {
    const responses = new Map([
      ['https://custom-registry.com/api/my-skill/SKILL.md', { ok: true, status: 200, body: SAMPLE_SKILL }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills', 'https://custom-registry.com/api'],
      logger: makeLogger(),
      fetchFn: makeMockFetch(responses),
    });

    const name = await registry.install(
      { name: 'my-skill', registryUrl: 'https://custom-registry.com/api' },
      tmpDir,
    );
    // Registry install uses the requested name, not the frontmatter name
    expect(name).toBe('my-skill');
  });

  it('rejects registry URL override not in configured allowlist', async () => {
    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills'],
      logger: makeLogger(),
    });

    await expect(
      registry.install({ name: 'skill', registryUrl: 'https://attacker.com/evil' }, tmpDir),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects non-https URLs (SSRF protection)', async () => {
    const registry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
    });

    await expect(
      registry.install({ url: 'http://example.com/skill.md' }, tmpDir),
    ).rejects.toThrow('only https URLs are allowed');
  });

  it('rejects private IP URLs (SSRF protection)', async () => {
    const registry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
    });

    await expect(
      registry.install({ url: 'https://127.0.0.1/skill.md' }, tmpDir),
    ).rejects.toThrow('private/link-local URLs are not allowed');
  });
});

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

describe('search', () => {
  it('queries registries and aggregates results', async () => {
    const searchResults = JSON.stringify({
      skills: [
        { name: 'email-monitor', description: 'Monitors email', source_url: 'https://example.com/email' },
        { name: 'code-review', description: 'Reviews code', source_url: 'https://example.com/review' },
      ],
    });

    const responses = new Map([
      ['https://clawhub.ai/skills/search?q=monitor', { ok: true, status: 200, body: searchResults }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills'],
      logger: makeLogger(),
      fetchFn: makeMockFetch(responses),
    });

    const results = await registry.search('monitor');
    expect(results).toHaveLength(2);
    expect(results[0]!.name).toBe('email-monitor');
    expect(results[0]!.registry_url).toBe('https://clawhub.ai/skills');
    expect(results[1]!.name).toBe('code-review');
  });

  it('returns empty array when registry returns no results', async () => {
    const responses = new Map([
      ['https://clawhub.ai/skills/search?q=xyz', { ok: true, status: 200, body: '{"skills":[]}' }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills'],
      logger: makeLogger(),
      fetchFn: makeMockFetch(responses),
    });

    const results = await registry.search('xyz');
    expect(results).toHaveLength(0);
  });

  it('handles registry errors gracefully', async () => {
    const warnings: string[] = [];
    const warnLogger = {
      info: () => undefined,
      warn: (msg: string) => { warnings.push(msg); },
      error: () => undefined,
    };

    const registry = new SkillRegistryImpl({
      registryUrls: ['https://down-registry.com'],
      logger: warnLogger,
      fetchFn: async () => { throw new Error('network error'); },
    });

    const results = await registry.search('test');
    expect(results).toHaveLength(0);
    expect(warnings).toContain('skill registry search failed');
  });

  it('skips registries that return non-OK status', async () => {
    const responses = new Map([
      ['https://bad-registry.com/search?q=test', { ok: false, status: 500, body: 'error' }],
    ]);

    const registry = new SkillRegistryImpl({
      registryUrls: ['https://bad-registry.com'],
      logger: makeLogger(),
      fetchFn: makeMockFetch(responses),
    });

    const results = await registry.search('test');
    expect(results).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listRegistries
// ---------------------------------------------------------------------------

describe('listRegistries', () => {
  it('returns configured registry URLs', () => {
    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills', 'https://skills.sh/registry'],
      logger: makeLogger(),
    });

    const urls = registry.listRegistries();
    expect(urls).toEqual(['https://clawhub.ai/skills', 'https://skills.sh/registry']);
  });

  it('returns empty array when no registries configured', () => {
    const registry = new SkillRegistryImpl({
      registryUrls: [],
      logger: makeLogger(),
    });

    expect(registry.listRegistries()).toEqual([]);
  });

  it('returns a copy (not the internal array)', () => {
    const registry = new SkillRegistryImpl({
      registryUrls: ['https://clawhub.ai/skills'],
      logger: makeLogger(),
    });

    const urls = registry.listRegistries();
    urls.push('https://injected.com');
    expect(registry.listRegistries()).toEqual(['https://clawhub.ai/skills']);
  });
});
