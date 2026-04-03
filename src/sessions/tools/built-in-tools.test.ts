/**
 * Built-in tools — unit tests.
 *
 * Tests Read, Write, Edit, Glob, Grep, Bash tools and the buildBuiltinTools barrel.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createReadTool } from './read.js';
import { createWriteTool } from './write.js';
import { createEditTool } from './edit.js';
import { createGlobTool } from './glob.js';
import { createGrepTool } from './grep.js';
import { createBashTool } from './bash.js';
import { buildBuiltinTools } from './index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const dirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-bt-'));
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

/** Default governance paths that won't block anything inside a temp dir. */
function govPaths(dir: string) {
  return {
    systemRulesDir: join(dir, '__sys__'),
    dataDir: join(dir, '__data__'),
    runDir: join(dir, '__run__'),
  };
}

/** Shared context argument required by AI SDK tool execute. */
const ctx = { toolCallId: 'test', messages: [] as never[] };

// Test-only fake credential values (NOT real secrets)
const FAKE_CRED = 'test-placeholder-cred-not-real';
const FAKE_CRED_2 = 'another-fake-token-placeholder';

// ── Read ─────────────────────────────────────────────────────────────────────

describe('Read tool', () => {
  it('reads a file and returns numbered lines', async () => {
    const cwd = makeTmpDir();
    const file = join(cwd, 'hello.txt');
    writeFileSync(file, 'line1\nline2\nline3\n');

    const readTool = createReadTool(cwd, []);
    const result = await readTool.execute!({ file_path: file }, ctx);

    expect(result).toContain('1\u2502line1');
    expect(result).toContain('2\u2502line2');
    expect(result).toContain('3\u2502line3');
  });

  it('respects offset and limit', async () => {
    const cwd = makeTmpDir();
    const file = join(cwd, 'data.txt');
    writeFileSync(file, 'a\nb\nc\nd\ne\n');

    const readTool = createReadTool(cwd, []);
    const result = await readTool.execute!(
      { file_path: file, offset: 2, limit: 2 },
      ctx,
    );

    expect(result).toContain('2\u2502b');
    expect(result).toContain('3\u2502c');
    expect(result).not.toContain('1\u2502a');
    expect(result).not.toContain('4\u2502d');
  });

  it('rejects a path outside the workspace boundary', async () => {
    const cwd = makeTmpDir();
    const outside = makeTmpDir();
    const file = join(outside, 'nope.txt');
    writeFileSync(file, 'nope');

    const readTool = createReadTool(cwd, []);
    await expect(
      readTool.execute!({ file_path: file }, ctx),
    ).rejects.toThrow('Access denied');
  });

  it('allows reading from additionalDirs', async () => {
    const cwd = makeTmpDir();
    const extra = makeTmpDir();
    const file = join(extra, 'allowed.txt');
    writeFileSync(file, 'ok');

    const readTool = createReadTool(cwd, [extra]);
    const result = await readTool.execute!({ file_path: file }, ctx);
    expect(result).toContain('ok');
  });
});

// ── Write ────────────────────────────────────────────────────────────────────

describe('Write tool', () => {
  it('writes content and creates parent directories', async () => {
    const cwd = makeTmpDir();
    const file = join(cwd, 'sub', 'dir', 'out.txt');

    const writeTool = createWriteTool(cwd, [], {}, govPaths(cwd), 'team-a');
    const result = await writeTool.execute!(
      { file_path: file, content: 'hello world' },
      ctx,
    );

    expect(result).toContain('Wrote');
    expect(result).toContain('11 bytes');
    expect(readFileSync(file, 'utf-8')).toBe('hello world');
  });

  it('scrubs credentials from written content', async () => {
    const cwd = makeTmpDir();
    const file = join(cwd, 'config.txt');
    const creds = { API_KEY: FAKE_CRED };

    const writeTool = createWriteTool(cwd, [], creds, govPaths(cwd), 'team-a');
    await writeTool.execute!(
      { file_path: file, content: `key=${FAKE_CRED}` },
      ctx,
    );

    const written = readFileSync(file, 'utf-8');
    expect(written).toBe('key=[CREDENTIAL:API_KEY]');
    expect(written).not.toContain(FAKE_CRED);
  });

  it('rejects path outside boundary', async () => {
    const cwd = makeTmpDir();
    const outside = makeTmpDir();

    const writeTool = createWriteTool(cwd, [], {}, govPaths(cwd), 'team-a');
    await expect(
      writeTool.execute!(
        { file_path: join(outside, 'hack.txt'), content: 'pwned' },
        ctx,
      ),
    ).rejects.toThrow('Access denied');
  });

  it('rejects governance-blocked paths', async () => {
    const cwd = makeTmpDir();
    const gov = govPaths(cwd);
    mkdirSync(gov.systemRulesDir, { recursive: true });

    const writeTool = createWriteTool(cwd, [], {}, gov, 'team-a');
    await expect(
      writeTool.execute!(
        { file_path: join(gov.systemRulesDir, 'rules.md'), content: 'bad' },
        ctx,
      ),
    ).rejects.toThrow('Governance');
  });
});

// ── Edit ─────────────────────────────────────────────────────────────────────

describe('Edit tool', () => {
  it('replaces first occurrence of a string', async () => {
    const cwd = makeTmpDir();
    const file = join(cwd, 'code.ts');
    writeFileSync(file, 'foo bar foo baz');

    const editTool = createEditTool(cwd, [], {}, govPaths(cwd), 'team-a');
    const result = await editTool.execute!(
      { file_path: file, old_string: 'foo', new_string: 'qux' },
      ctx,
    );

    expect(result).toContain('1 occurrence');
    expect(readFileSync(file, 'utf-8')).toBe('qux bar foo baz');
  });

  it('replaces all occurrences when replace_all is true', async () => {
    const cwd = makeTmpDir();
    const file = join(cwd, 'code.ts');
    writeFileSync(file, 'foo bar foo baz foo');

    const editTool = createEditTool(cwd, [], {}, govPaths(cwd), 'team-a');
    const result = await editTool.execute!(
      {
        file_path: file,
        old_string: 'foo',
        new_string: 'qux',
        replace_all: true,
      },
      ctx,
    );

    expect(result).toContain('3 occurrence');
    expect(readFileSync(file, 'utf-8')).toBe('qux bar qux baz qux');
  });

  it('throws when old_string is not found', async () => {
    const cwd = makeTmpDir();
    const file = join(cwd, 'code.ts');
    writeFileSync(file, 'hello world');

    const editTool = createEditTool(cwd, [], {}, govPaths(cwd), 'team-a');
    await expect(
      editTool.execute!(
        { file_path: file, old_string: 'missing', new_string: 'x' },
        ctx,
      ),
    ).rejects.toThrow('old_string not found');
  });

  it('rejects path outside boundary', async () => {
    const cwd = makeTmpDir();
    const outside = makeTmpDir();
    const file = join(outside, 'file.txt');
    writeFileSync(file, 'content');

    const editTool = createEditTool(cwd, [], {}, govPaths(cwd), 'team-a');
    await expect(
      editTool.execute!(
        { file_path: file, old_string: 'content', new_string: 'hacked' },
        ctx,
      ),
    ).rejects.toThrow('Access denied');
  });

  it('scrubs credentials from replacement content', async () => {
    const cwd = makeTmpDir();
    const file = join(cwd, 'env.txt');
    writeFileSync(file, 'KEY=placeholder');
    const creds = { DB_PASS: FAKE_CRED_2 };

    const editTool = createEditTool(cwd, [], creds, govPaths(cwd), 'team-a');
    await editTool.execute!(
      {
        file_path: file,
        old_string: 'placeholder',
        new_string: FAKE_CRED_2,
      },
      ctx,
    );

    const written = readFileSync(file, 'utf-8');
    expect(written).toBe('KEY=[CREDENTIAL:DB_PASS]');
  });
});

// ── Glob ─────────────────────────────────────────────────────────────────────

describe('Glob tool', () => {
  it('finds files matching a pattern', async () => {
    const cwd = makeTmpDir();
    mkdirSync(join(cwd, 'src'));
    writeFileSync(join(cwd, 'src', 'a.ts'), '');
    writeFileSync(join(cwd, 'src', 'b.ts'), '');
    writeFileSync(join(cwd, 'src', 'c.js'), '');

    const globTool = createGlobTool(cwd, []);
    const result = await globTool.execute!({ pattern: '**/*.ts' }, ctx);

    expect(result).toContain('a.ts');
    expect(result).toContain('b.ts');
    expect(result).not.toContain('c.js');
  });

  it('returns "No files matched" for no results', async () => {
    const cwd = makeTmpDir();

    const globTool = createGlobTool(cwd, []);
    const result = await globTool.execute!({ pattern: '**/*.xyz' }, ctx);

    expect(result).toBe('No files matched the pattern.');
  });

  it('respects custom path', async () => {
    const cwd = makeTmpDir();
    const sub = join(cwd, 'nested');
    mkdirSync(sub);
    writeFileSync(join(sub, 'deep.ts'), '');
    writeFileSync(join(cwd, 'shallow.ts'), '');

    const globTool = createGlobTool(cwd, []);
    const result = await globTool.execute!(
      { pattern: '*.ts', path: sub },
      ctx,
    );

    expect(result).toContain('deep.ts');
    expect(result).not.toContain('shallow.ts');
  });

  it('rejects path outside boundary', async () => {
    const cwd = makeTmpDir();
    const outside = makeTmpDir();

    const globTool = createGlobTool(cwd, []);
    await expect(
      globTool.execute!({ pattern: '**/*', path: outside }, ctx),
    ).rejects.toThrow('Access denied');
  });
});

// ── Grep ─────────────────────────────────────────────────────────────────────

describe('Grep tool', () => {
  it('finds content matching a pattern', async () => {
    const cwd = makeTmpDir();
    writeFileSync(join(cwd, 'file.txt'), 'hello world\nfoo bar\nhello again');

    const grepTool = createGrepTool(cwd, []);
    const result = await grepTool.execute!({ pattern: 'hello' }, ctx);

    expect(result).toContain('hello world');
    expect(result).toContain('hello again');
    expect(result).not.toContain('foo bar');
  });

  it('returns "No matches found" for no results', async () => {
    const cwd = makeTmpDir();
    writeFileSync(join(cwd, 'file.txt'), 'nothing here');

    const grepTool = createGrepTool(cwd, []);
    const result = await grepTool.execute!(
      { pattern: 'xyz_not_present' },
      ctx,
    );

    expect(result).toBe('No matches found.');
  });

  it('respects type filter', async () => {
    const cwd = makeTmpDir();
    writeFileSync(join(cwd, 'code.ts'), 'function hello() {}');
    writeFileSync(join(cwd, 'readme.md'), 'hello world');

    const grepTool = createGrepTool(cwd, []);
    const result = await grepTool.execute!(
      { pattern: 'hello', type: 'ts' },
      ctx,
    );

    expect(result).toContain('code.ts');
    expect(result).not.toContain('readme.md');
  });

  it('rejects path outside boundary', async () => {
    const cwd = makeTmpDir();
    const outside = makeTmpDir();

    const grepTool = createGrepTool(cwd, []);
    await expect(
      grepTool.execute!({ pattern: 'test', path: outside }, ctx),
    ).rejects.toThrow('Access denied');
  });
});

// ── Bash ─────────────────────────────────────────────────────────────────────

describe('Bash tool', () => {
  it('runs a command and returns stdout', async () => {
    const cwd = makeTmpDir();

    const bashTool = createBashTool(cwd, {});
    const result = await bashTool.execute!(
      { command: 'echo "hello world"' },
      ctx,
    );

    expect(result).toContain('hello world');
  });

  it('returns combined output on non-zero exit', async () => {
    const cwd = makeTmpDir();

    const bashTool = createBashTool(cwd, {});
    const result = await bashTool.execute!(
      { command: 'echo err >&2; exit 1' },
      ctx,
    );

    expect(result).toContain('err');
  });

  it('scrubs credentials from output', async () => {
    const cwd = makeTmpDir();
    const creds = { TOKEN: FAKE_CRED };

    const bashTool = createBashTool(cwd, creds);
    const result = await bashTool.execute!(
      { command: `echo "token=${FAKE_CRED}"` },
      ctx,
    );

    expect(result).toContain('[CREDENTIAL:TOKEN]');
    expect(result).not.toContain(FAKE_CRED);
  });

  it('rejects command that writes credentials to a file', async () => {
    const cwd = makeTmpDir();
    const creds = { CRED: FAKE_CRED };

    const bashTool = createBashTool(cwd, creds);
    await expect(
      bashTool.execute!(
        { command: `echo ${FAKE_CRED} > /tmp/leak.txt` },
        ctx,
      ),
    ).rejects.toThrow('Credential guard');
  });

  it('allows commands with credentials that do not write to files', async () => {
    const cwd = makeTmpDir();
    const creds = { KEY: FAKE_CRED };

    const bashTool = createBashTool(cwd, creds);
    // echo without redirect is fine (stdout is scrubbed)
    const result = await bashTool.execute!(
      { command: `echo "${FAKE_CRED}"` },
      ctx,
    );

    expect(result).toContain('[CREDENTIAL:KEY]');
  });
});

// ── buildBuiltinTools ────────────────────────────────────────────────────────

describe('buildBuiltinTools', () => {
  it('returns all 6 tools with execute functions', () => {
    const cwd = makeTmpDir();
    const tools = buildBuiltinTools({
      cwd,
      additionalDirs: [],
      credentials: {},
      governancePaths: govPaths(cwd),
      teamName: 'test-team',
    });

    expect(Object.keys(tools)).toHaveLength(6);
    expect(Object.keys(tools).sort()).toEqual([
      'Bash',
      'Edit',
      'Glob',
      'Grep',
      'Read',
      'Write',
    ]);
    for (const t of Object.values(tools)) {
      expect(typeof t.execute).toBe('function');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeDefined();
    }
  });
});
