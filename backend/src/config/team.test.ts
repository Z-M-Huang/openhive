/**
 * Tests for backend/src/config/team.ts
 *
 * Covers validateTeamPath, loadTeamFromFile, saveTeamToFile, and
 * createTeamDirectory.
 *
 * All file I/O tests use real temporary directories (os.tmpdir) to exercise
 * the actual read/write/rename/mkdir paths — no mocking of fs.
 *
 * Symlink tests use symlinkSync to create actual symlinks in the temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  symlinkSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify as stringifyYaml } from 'yaml';

import {
  validateTeamPath,
  loadTeamFromFile,
  saveTeamToFile,
  createTeamDirectory,
} from './team.js';
import { ValidationError } from '../domain/errors.js';
import type { Team } from '../domain/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a temp directory, returns its path and a cleanup function. */
function makeTmpDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'openhive-team-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Creates the teams/ subdirectory inside dir and returns its path.
 * This matches the expected data directory layout.
 */
function makeTeamsDir(dir: string): string {
  const teamsDir = join(dir, 'teams');
  mkdirSync(teamsDir, { recursive: true });
  return teamsDir;
}

// ---------------------------------------------------------------------------
// validateTeamPath
// ---------------------------------------------------------------------------

describe('validateTeamPath', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
    makeTeamsDir(dir);
  });

  afterEach(() => cleanup());

  it('accepts a valid slug and returns an absolute path inside teams/', () => {
    const result = validateTeamPath(dir, 'my-team');

    expect(result).toBeDefined();
    // Must be absolute
    expect(result.startsWith('/')).toBe(true);
    // Must contain the slug component
    expect(result).toContain('my-team');
    // Must be inside the teams/ directory
    expect(result).toContain(`${dir}/teams/my-team`);
  });

  it('accepts a single-segment slug', () => {
    const result = validateTeamPath(dir, 'alpha');

    expect(result).toContain('/teams/alpha');
  });

  it('accepts a multi-segment kebab slug', () => {
    const result = validateTeamPath(dir, 'dev-buddy-v2');

    expect(result).toContain('/teams/dev-buddy-v2');
  });

  it('rejects a slug with path traversal (..)', () => {
    expect(() => validateTeamPath(dir, '..')).toThrow(ValidationError);
  });

  it('rejects a slug with embedded path traversal', () => {
    // validateSlug catches '..' as a substring
    expect(() => validateTeamPath(dir, 'foo..bar')).toThrow(ValidationError);
  });

  it('rejects a slug containing a forward slash', () => {
    expect(() => validateTeamPath(dir, 'foo/bar')).toThrow(ValidationError);
  });

  it('rejects an empty slug', () => {
    expect(() => validateTeamPath(dir, '')).toThrow(ValidationError);
  });

  it('rejects a slug that resolves outside the teams directory', () => {
    // On Linux, resolve(join(dir, 'teams', '..', 'evil')) points outside teams/.
    // The slug regex blocks most such cases, but we also test the prefix guard.
    // We cannot produce this via slug alone without path separators, but we
    // verify the prefix guard is in place by using a slug that passes regex
    // validation yet attempts to escape (slugPattern would block '/', so this
    // test confirms the slug regex handles that case).
    expect(() => validateTeamPath(dir, '../etc')).toThrow(ValidationError);
  });

  it('rejects a symlink at the team directory level', () => {
    const realDir = join(dir, 'real-team');
    mkdirSync(realDir);
    const linkPath = join(dir, 'teams', 'linked-team');
    symlinkSync(realDir, linkPath);

    expect(() => validateTeamPath(dir, 'linked-team')).toThrow(ValidationError);
    try {
      validateTeamPath(dir, 'linked-team');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('slug');
      expect((err as ValidationError).message).toContain('symlink');
    }
  });

  it('rejects a symlink at the teams directory level', () => {
    // Remove the real teams/ dir and replace with a symlink.
    const realTeamsTarget = join(dir, 'teams-real');
    mkdirSync(realTeamsTarget);
    rmSync(join(dir, 'teams'), { recursive: true });
    symlinkSync(realTeamsTarget, join(dir, 'teams'));

    expect(() => validateTeamPath(dir, 'any-team')).toThrow(ValidationError);
    try {
      validateTeamPath(dir, 'any-team');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('teams_dir');
    }
  });

  it('succeeds when the teams/ directory does not exist (creation scenario)', () => {
    // Remove the teams/ dir entirely — validateTeamPath should still return a
    // path (creation of the dir happens later in createTeamDirectory).
    rmSync(join(dir, 'teams'), { recursive: true });

    const result = validateTeamPath(dir, 'new-team');

    expect(result).toContain('/teams/new-team');
  });

  it('succeeds when the team directory does not yet exist', () => {
    // teams/ exists but no team sub-directory yet.
    const result = validateTeamPath(dir, 'brand-new');

    expect(result).toContain('/teams/brand-new');
  });
});

// ---------------------------------------------------------------------------
// loadTeamFromFile
// ---------------------------------------------------------------------------

describe('loadTeamFromFile', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  it('reads a valid team YAML and returns a Team with the slug set', () => {
    const teamData = {
      tid: 'tid-abc-123',
      leader_aid: 'aid-xyz-456',
    };
    const path = join(dir, 'team.yaml');
    writeFileSync(path, stringifyYaml(teamData), 'utf8');

    const team = loadTeamFromFile(path, 'my-team');

    expect(team.slug).toBe('my-team');
    expect(team.tid).toBe('tid-abc-123');
    expect(team.leader_aid).toBe('aid-xyz-456');
  });

  it('sets the slug from the argument, not from the YAML content', () => {
    // YAML has no slug field (intentional — slug comes from directory name)
    const path = join(dir, 'team.yaml');
    writeFileSync(path, stringifyYaml({ leader_aid: 'aid-aaa-bbb' }), 'utf8');

    const team = loadTeamFromFile(path, 'resolved-slug');

    expect(team.slug).toBe('resolved-slug');
  });

  it('reads optional fields when present', () => {
    const teamData = {
      tid: 'tid-def-789',
      leader_aid: 'aid-ghi-012',
      parent_slug: 'parent',
      children: ['child-a', 'child-b'],
      env_vars: { FOO: 'bar' },
    };
    const path = join(dir, 'team.yaml');
    writeFileSync(path, stringifyYaml(teamData), 'utf8');

    const team = loadTeamFromFile(path, 'child-team');

    expect(team.parent_slug).toBe('parent');
    expect(team.children).toEqual(['child-a', 'child-b']);
    expect(team.env_vars).toEqual({ FOO: 'bar' });
  });

  it('handles an empty (but valid) YAML file gracefully', () => {
    const path = join(dir, 'team.yaml');
    writeFileSync(path, '', 'utf8');

    const team = loadTeamFromFile(path, 'empty-team');

    expect(team.slug).toBe('empty-team');
    expect(team.tid).toBe('');
    expect(team.leader_aid).toBe('');
  });

  it('throws an error when the file does not exist', () => {
    expect(() => loadTeamFromFile('/nonexistent/path/team.yaml', 'slug')).toThrow(
      /failed to read team config/,
    );
  });

  it('throws an error when the YAML is malformed', () => {
    const path = join(dir, 'team.yaml');
    writeFileSync(path, '{ bad yaml: [missing bracket', 'utf8');

    expect(() => loadTeamFromFile(path, 'slug')).toThrow(/failed to parse team config/);
  });
});

// ---------------------------------------------------------------------------
// saveTeamToFile
// ---------------------------------------------------------------------------

describe('saveTeamToFile', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
  });

  afterEach(() => cleanup());

  const sampleTeam: Team = {
    tid: 'tid-save-001',
    slug: 'save-test',
    leader_aid: 'aid-lead-001',
  };

  it('writes a team config to disk as YAML', () => {
    const path = join(dir, 'team.yaml');

    saveTeamToFile(path, sampleTeam);

    expect(existsSync(path)).toBe(true);
    const raw = readFileSync(path, 'utf8');
    expect(raw).toContain('tid-save-001');
    expect(raw).toContain('aid-lead-001');
  });

  it('performs an atomic write (no .tmp file left behind)', () => {
    const path = join(dir, 'team.yaml');
    const tmpPath = path + '.tmp';

    saveTeamToFile(path, sampleTeam);

    expect(existsSync(path)).toBe(true);
    expect(existsSync(tmpPath)).toBe(false);
  });

  it('written team can be read back with loadTeamFromFile', () => {
    const path = join(dir, 'roundtrip.yaml');

    saveTeamToFile(path, sampleTeam);
    const loaded = loadTeamFromFile(path, 'save-test');

    expect(loaded.tid).toBe('tid-save-001');
    expect(loaded.leader_aid).toBe('aid-lead-001');
    expect(loaded.slug).toBe('save-test');
  });

  it('overwrites an existing file atomically', () => {
    const path = join(dir, 'team.yaml');

    saveTeamToFile(path, sampleTeam);
    saveTeamToFile(path, { ...sampleTeam, tid: 'tid-updated-002', slug: 'save-test' });

    const loaded = loadTeamFromFile(path, 'save-test');
    expect(loaded.tid).toBe('tid-updated-002');
  });

  it('throws an error when the directory does not exist', () => {
    const path = '/nonexistent/dir/team.yaml';

    expect(() => saveTeamToFile(path, sampleTeam)).toThrow(/failed to write temp team config/);
  });
});

// ---------------------------------------------------------------------------
// createTeamDirectory
// ---------------------------------------------------------------------------

describe('createTeamDirectory', () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = makeTmpDir());
    makeTeamsDir(dir);
  });

  afterEach(() => cleanup());

  it('creates the team root directory', () => {
    createTeamDirectory(dir, 'my-team');

    expect(existsSync(join(dir, 'teams', 'my-team'))).toBe(true);
  });

  it('does not create workspace subdirectories (agents/, skills/, CLAUDE.md)', () => {
    createTeamDirectory(dir, 'my-team');

    // Workspace files belong in .run/teams/<slug>/, not data/teams/<slug>/.
    expect(existsSync(join(dir, 'teams', 'my-team', 'agents'))).toBe(false);
    expect(existsSync(join(dir, 'teams', 'my-team', 'skills'))).toBe(false);
    expect(existsSync(join(dir, 'teams', 'my-team', 'CLAUDE.md'))).toBe(false);
  });

  it('creates a minimal team.yaml', () => {
    createTeamDirectory(dir, 'my-team');

    const teamFile = join(dir, 'teams', 'my-team', 'team.yaml');
    expect(existsSync(teamFile)).toBe(true);
    const raw = readFileSync(teamFile, 'utf8');
    // Minimal team.yaml must reference the slug
    expect(raw).toContain('my-team');
  });

  it('does not overwrite an existing team.yaml', () => {
    // Create the directory manually with a custom team.yaml
    const teamDir = join(dir, 'teams', 'existing-team');
    mkdirSync(teamDir, { recursive: true });
    const teamFile = join(teamDir, 'team.yaml');
    writeFileSync(teamFile, 'tid: tid-custom-123\n', 'utf8');

    createTeamDirectory(dir, 'existing-team');

    const raw = readFileSync(teamFile, 'utf8');
    expect(raw).toContain('tid-custom-123');
  });

  it('is idempotent — calling twice does not throw', () => {
    createTeamDirectory(dir, 'idempotent-team');

    expect(() => createTeamDirectory(dir, 'idempotent-team')).not.toThrow();
  });

  it('rejects an invalid slug with ValidationError', () => {
    expect(() => createTeamDirectory(dir, '..')).toThrow(ValidationError);
  });

  it('rejects a slug with path traversal', () => {
    expect(() => createTeamDirectory(dir, 'foo/bar')).toThrow(ValidationError);
  });
});
