/**
 * Tool Guards — unit tests.
 *
 * Tests assertInsideBoundary, assertGovernanceAllowed, assertBashSafe,
 * and scrubCredentialsFromContent (from credential-scrubber).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  assertInsideBoundary,
  assertGovernanceAllowed,
  assertBashSafe,
} from './tool-guards.js';
import { scrubCredentialsFromContent } from '../../logging/credential-scrubber.js';
import type { GovernancePaths } from './tool-guards.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const dirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-tg-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  dirs.length = 0;
});

// ── assertInsideBoundary ─────────────────────────────────────────────────────

describe('assertInsideBoundary', () => {
  it('allows a path inside cwd', () => {
    const cwd = makeTmpDir();
    expect(() =>
      assertInsideBoundary(join(cwd, 'src', 'file.ts'), cwd, []),
    ).not.toThrow();
  });

  it('allows cwd itself', () => {
    const cwd = makeTmpDir();
    expect(() => assertInsideBoundary(cwd, cwd, [])).not.toThrow();
  });

  it('throws for a path outside cwd', () => {
    const cwd = makeTmpDir();
    const outside = makeTmpDir();
    expect(() =>
      assertInsideBoundary(join(outside, 'secret.txt'), cwd, []),
    ).toThrow('outside workspace boundaries');
  });

  it('throws for ../traversal attempt', () => {
    const cwd = makeTmpDir();
    expect(() =>
      assertInsideBoundary(join(cwd, '..', 'etc', 'passwd'), cwd, []),
    ).toThrow('outside workspace boundaries');
  });

  it('blocks symlink escape', () => {
    const cwd = makeTmpDir();
    const outside = makeTmpDir();
    const escapedFile = join(outside, 'secret.txt');
    writeFileSync(escapedFile, 'secret data');

    // Create symlink inside cwd pointing to outside directory
    const linkPath = join(cwd, 'sneaky-link');
    symlinkSync(outside, linkPath);

    expect(() =>
      assertInsideBoundary(join(linkPath, 'secret.txt'), cwd, []),
    ).toThrow('outside workspace boundaries');
  });

  it('allows paths inside additionalDirs', () => {
    const cwd = makeTmpDir();
    const extra = makeTmpDir();
    expect(() =>
      assertInsideBoundary(join(extra, 'allowed.ts'), cwd, [extra]),
    ).not.toThrow();
  });

  it('handles relative paths by resolving against cwd', () => {
    const cwd = makeTmpDir();
    mkdirSync(join(cwd, 'sub'), { recursive: true });
    expect(() =>
      assertInsideBoundary('sub/file.ts', cwd, []),
    ).not.toThrow();
  });

  it('throws for relative path that escapes cwd', () => {
    const cwd = makeTmpDir();
    expect(() =>
      assertInsideBoundary('../../etc/passwd', cwd, []),
    ).toThrow('outside workspace boundaries');
  });
});

// ── assertGovernanceAllowed ──────────────────────────────────────────────────

describe('assertGovernanceAllowed', () => {
  let tmpDir: string;
  let paths: GovernancePaths;

  function setup(): void {
    tmpDir = makeTmpDir();
    // Create the directories so realpathSync works
    mkdirSync(join(tmpDir, 'system-rules'), { recursive: true });
    mkdirSync(join(tmpDir, 'data', 'rules'), { recursive: true });
    mkdirSync(join(tmpDir, 'run', 'teams', 'my-team', 'org-rules'), { recursive: true });
    mkdirSync(join(tmpDir, 'run', 'teams', 'my-team', 'team-rules'), { recursive: true });
    mkdirSync(join(tmpDir, 'run', 'teams', 'my-team', 'skills'), { recursive: true });
    mkdirSync(join(tmpDir, 'run', 'teams', 'my-team', 'subagents'), { recursive: true });
    mkdirSync(join(tmpDir, 'run', 'teams', 'my-team', 'memory'), { recursive: true });
    mkdirSync(join(tmpDir, 'run', 'teams', 'rival-team', 'team-rules'), { recursive: true });

    paths = {
      systemRulesDir: join(tmpDir, 'system-rules'),
      dataDir: join(tmpDir, 'data'),
      runDir: join(tmpDir, 'run'),
    };
  }

  it('blocks write to system-rules', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'system-rules', 'policy.md'),
        'my-team',
        paths,
      ),
    ).toThrow('system-rules');
  });

  it('blocks write to admin org-rules (dataDir/rules/)', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'data', 'rules', 'global', 'safety.md'),
        'my-team',
        paths,
      ),
    ).toThrow('admin-org-rules');
  });

  it('blocks write to other team directory', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'run', 'teams', 'rival-team', 'team-rules', 'hack.md'),
        'my-team',
        paths,
      ),
    ).toThrow('other-team');
  });

  it('blocks write to own config.yaml', () => {
    setup();
    // Create the file so realpathSync can resolve it
    writeFileSync(join(tmpDir, 'run', 'teams', 'my-team', 'config.yaml'), '');
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'run', 'teams', 'my-team', 'config.yaml'),
        'my-team',
        paths,
      ),
    ).toThrow('own-config');
  });

  it('allows write to own org-rules', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'run', 'teams', 'my-team', 'org-rules', 'rule.md'),
        'my-team',
        paths,
      ),
    ).not.toThrow();
  });

  it('allows write to own team-rules', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'run', 'teams', 'my-team', 'team-rules', 'style.md'),
        'my-team',
        paths,
      ),
    ).not.toThrow();
  });

  it('allows write to own skills', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'run', 'teams', 'my-team', 'skills', 'SKILL.md'),
        'my-team',
        paths,
      ),
    ).not.toThrow();
  });

  it('allows write to own subagents', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'run', 'teams', 'my-team', 'subagents', 'agent.md'),
        'my-team',
        paths,
      ),
    ).not.toThrow();
  });

  it('allows write to own memory', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        join(tmpDir, 'run', 'teams', 'my-team', 'memory', 'notes.md'),
        'my-team',
        paths,
      ),
    ).not.toThrow();
  });

  it('allows write to non-data workspace paths', () => {
    setup();
    expect(() =>
      assertGovernanceAllowed(
        '/tmp/workspace/output.txt',
        'my-team',
        paths,
      ),
    ).not.toThrow();
  });
});

// ── scrubCredentialsFromContent ──────────────────────────────────────────────

describe('scrubCredentialsFromContent', () => {
  // Test-only fake credential values (NOT real secrets)
  const FAKE_KEY = 'test-placeholder-cred-not-real';
  const FAKE_TOKEN = 'another-fake-token-value';

  it('replaces credential values with [CREDENTIAL:key] placeholders', () => {
    const result = scrubCredentialsFromContent(
      `api_key=${FAKE_KEY}`,
      { API_KEY: FAKE_KEY },
    );
    expect(result).toBe('api_key=[CREDENTIAL:API_KEY]');
  });

  it('handles multiple credentials', () => {
    const result = scrubCredentialsFromContent(
      `key=${FAKE_KEY} token=${FAKE_TOKEN}`,
      { API_KEY: FAKE_KEY, AUTH_TOKEN: FAKE_TOKEN },
    );
    expect(result).toBe('key=[CREDENTIAL:API_KEY] token=[CREDENTIAL:AUTH_TOKEN]');
  });

  it('ignores credentials shorter than 8 chars', () => {
    const result = scrubCredentialsFromContent(
      'pin=abc1234',
      { PIN: 'abc1234' },
    );
    expect(result).toBe('pin=abc1234');
  });

  it('returns content unchanged when no credentials match', () => {
    const result = scrubCredentialsFromContent(
      'no secrets here',
      { API_KEY: FAKE_KEY },
    );
    expect(result).toBe('no secrets here');
  });

  it('returns content unchanged when credentials map is empty', () => {
    const result = scrubCredentialsFromContent('some content', {});
    expect(result).toBe('some content');
  });

  it('replaces multiple occurrences of the same credential', () => {
    const result = scrubCredentialsFromContent(
      `first=${FAKE_KEY} second=${FAKE_KEY}`,
      { API_KEY: FAKE_KEY },
    );
    expect(result).toBe('first=[CREDENTIAL:API_KEY] second=[CREDENTIAL:API_KEY]');
  });
});

// ── assertBashSafe ───────────────────────────────────────────────────────────

describe('assertBashSafe', () => {
  // Test-only fake credential values (NOT real secrets)
  const FAKE_CRED = 'test-placeholder-cred-not-real';
  const creds = { API_KEY: FAKE_CRED, SHORT: 'abc' };

  it('allows normal commands without credentials', () => {
    expect(() =>
      assertBashSafe('echo hello > /tmp/file.txt', creds),
    ).not.toThrow();
  });

  it('allows commands that use credentials without file writes', () => {
    expect(() =>
      assertBashSafe(`curl -H "Bearer ${FAKE_CRED}" https://api.example.com`, creds),
    ).not.toThrow();
  });

  it('throws when command writes credential to file via >', () => {
    expect(() =>
      assertBashSafe(`echo ${FAKE_CRED} > /tmp/out.txt`, creds),
    ).toThrow('Credential guard');
  });

  it('throws when command writes credential to file via >>', () => {
    expect(() =>
      assertBashSafe(`echo ${FAKE_CRED} >> /tmp/out.txt`, creds),
    ).toThrow('Credential guard');
  });

  it('throws when command writes credential to file via tee', () => {
    expect(() =>
      assertBashSafe(`echo ${FAKE_CRED} | tee /tmp/out.txt`, creds),
    ).toThrow('Credential guard');
  });

  it('includes matched credential keys in error message', () => {
    expect(() =>
      assertBashSafe(`echo ${FAKE_CRED} > /tmp/out.txt`, creds),
    ).toThrow('API_KEY');
  });

  it('ignores short credentials (< 8 chars)', () => {
    expect(() =>
      assertBashSafe('echo abc > /tmp/file.txt', creds),
    ).not.toThrow();
  });

  it('allows when credentials map is empty', () => {
    expect(() =>
      assertBashSafe(`echo ${FAKE_CRED} > /tmp/file.txt`, {}),
    ).not.toThrow();
  });
});
