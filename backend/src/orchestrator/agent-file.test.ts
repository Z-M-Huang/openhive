/**
 * Tests for agent-file.ts
 *
 * Covers:
 *   1. parseAgentFileContent parses valid frontmatter and returns AgentFileDefinition
 *   2. parseAgentFileContent rejects file with missing required 'name' field
 *   3. parseAgentFileContent rejects file with missing required 'description' field
 *   4. parseAgentFileContent rejects file with non-string 'tools' entries
 *   5. parseAgentFileContent throws ValidationError when file has no frontmatter
 *   6. parseAgentFileContent rejects dangerous YAML tags (!!js/function etc.)
 *   7. loadAllAgentFiles loads multiple .md files and skips invalid ones
 *   8. loadAgentFile reads from filesystem (integration via tmp dir)
 *   9. parseAgentFileContent accepts optional model field
 *  10. parseAgentFileContent rejects non-array tools
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  parseAgentFileContent,
  loadAgentFile,
  loadAllAgentFiles,
  type AgentFileDefinition,
  type AgentFileLogger,
} from './agent-file.js';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function makeLogger(): AgentFileLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

// ---------------------------------------------------------------------------
// parseAgentFileContent — valid input
// ---------------------------------------------------------------------------

describe('parseAgentFileContent — valid input', () => {
  it('parses valid frontmatter with all fields and returns AgentFileDefinition', () => {
    const content = `---
name: My Agent
description: worker.role.md
model: sonnet
tools:
  - bash
  - git
---

Agent: My Agent
`;
    const def = parseAgentFileContent(content);
    expect(def.name).toBe('My Agent');
    expect(def.description).toBe('worker.role.md');
    expect(def.model).toBe('sonnet');
    expect(def.tools).toEqual(['bash', 'git']);
  });

  it('parses valid frontmatter with only required fields', () => {
    const content = `---
name: Minimal Agent
description: minimal.role.md
---
`;
    const def = parseAgentFileContent(content);
    expect(def.name).toBe('Minimal Agent');
    expect(def.description).toBe('minimal.role.md');
    expect(def.model).toBeUndefined();
    expect(def.tools).toBeUndefined();
  });

  it('parses frontmatter with optional model field', () => {
    const content = `---
name: Haiku Agent
description: haiku.role.md
model: haiku
---
`;
    const def: AgentFileDefinition = parseAgentFileContent(content);
    expect(def.model).toBe('haiku');
  });

  it('parses frontmatter with empty tools array', () => {
    const content = `---
name: No Tools Agent
description: no-tools.role.md
tools: []
---
`;
    const def = parseAgentFileContent(content);
    expect(def.tools).toEqual([]);
  });

  it('tolerates leading whitespace before opening ---', () => {
    const content = `\n\n---
name: Whitespace Agent
description: whitespace.role.md
---
`;
    const def = parseAgentFileContent(content);
    expect(def.name).toBe('Whitespace Agent');
  });
});

// ---------------------------------------------------------------------------
// parseAgentFileContent — missing required fields
// ---------------------------------------------------------------------------

describe('parseAgentFileContent — missing required fields', () => {
  it('throws ValidationError when name field is missing', () => {
    const content = `---
description: worker.role.md
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow('missing required field: name');
  });

  it('throws ValidationError when name field is empty string', () => {
    const content = `---
name: ""
description: worker.role.md
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow('missing required field: name');
  });

  it('throws ValidationError when description field is missing', () => {
    const content = `---
name: My Agent
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow('missing required field: description');
  });

  it('throws ValidationError when description field is empty string', () => {
    const content = `---
name: My Agent
description: ""
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow('missing required field: description');
  });
});

// ---------------------------------------------------------------------------
// parseAgentFileContent — invalid tools field
// ---------------------------------------------------------------------------

describe('parseAgentFileContent — invalid tools field', () => {
  it('throws ValidationError when tools contains non-string entries', () => {
    const content = `---
name: Bad Tools Agent
description: agent.role.md
tools:
  - bash
  - 42
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow('must contain only strings');
  });

  it('throws ValidationError when tools is not an array', () => {
    const content = `---
name: Bad Tools Agent
description: agent.role.md
tools: "bash"
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow('must be an array');
  });
});

// ---------------------------------------------------------------------------
// parseAgentFileContent — missing frontmatter
// ---------------------------------------------------------------------------

describe('parseAgentFileContent — missing frontmatter', () => {
  it('throws ValidationError when file has no frontmatter (no opening ---)', () => {
    const content = `name: My Agent
description: worker.role.md
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow('no YAML frontmatter');
  });

  it('throws ValidationError when frontmatter is not terminated', () => {
    const content = `---
name: My Agent
description: worker.role.md
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow('not terminated');
  });

  it('throws ValidationError when frontmatter is not a mapping object (e.g. scalar)', () => {
    const content = `---
just a string
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// parseAgentFileContent — dangerous YAML tags
// ---------------------------------------------------------------------------

describe('parseAgentFileContent — dangerous YAML tags', () => {
  it('rejects !!js/function tag (dangerous YAML)', () => {
    const content = `---
name: !!js/function "function(){return process.env}"
description: agent.role.md
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow(
      'dangerous or unsupported YAML tags',
    );
  });

  it('rejects !!js/undefined tag (non-core YAML tag)', () => {
    const content = `---
name: My Agent
description: !!js/undefined ~
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow(
      'dangerous or unsupported YAML tags',
    );
  });

  it('rejects !!python/object tag', () => {
    const content = `---
name: !!python/object foo
description: agent.role.md
---
`;
    expect(() => parseAgentFileContent(content)).toThrow(ValidationError);
    expect(() => parseAgentFileContent(content)).toThrow(
      'dangerous or unsupported YAML tags',
    );
  });
});

// ---------------------------------------------------------------------------
// loadAgentFile — filesystem integration
// ---------------------------------------------------------------------------

describe('loadAgentFile — filesystem integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `agent-file-test-${randomUUID()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads and parses a valid agent file from disk', () => {
    const filePath = join(tmpDir, 'worker.md');
    writeFileSync(
      filePath,
      `---
name: Worker Agent
description: worker.role.md
model: sonnet
tools:
  - bash
---

Agent: Worker Agent
`,
    );

    const def = loadAgentFile(filePath);
    expect(def.name).toBe('Worker Agent');
    expect(def.description).toBe('worker.role.md');
    expect(def.model).toBe('sonnet');
    expect(def.tools).toEqual(['bash']);
  });

  it('throws when file does not exist', () => {
    expect(() => loadAgentFile(join(tmpDir, 'nonexistent.md'))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadAllAgentFiles
// ---------------------------------------------------------------------------

describe('loadAllAgentFiles', () => {
  let agentsDir: string;

  beforeEach(() => {
    agentsDir = join(tmpdir(), `agent-files-test-${randomUUID()}`, '.claude', 'agents');
    mkdirSync(agentsDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up the test tmp directory
    const root = agentsDir.split('.claude')[0]!;
    rmSync(root, { recursive: true, force: true });
  });

  it('returns empty array when directory does not exist', () => {
    const logger = makeLogger();
    const result = loadAllAgentFiles(join(agentsDir, 'nonexistent'), logger);
    expect(result).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('loads multiple .md files successfully', () => {
    writeFileSync(
      join(agentsDir, 'worker.md'),
      `---
name: Worker
description: worker.role.md
---
`,
    );
    writeFileSync(
      join(agentsDir, 'analyst.md'),
      `---
name: Analyst
description: analyst.role.md
model: opus
---
`,
    );

    const logger = makeLogger();
    const result = loadAllAgentFiles(agentsDir, logger);
    expect(result).toHaveLength(2);
    const names = result.map((d) => d.name).sort();
    expect(names).toEqual(['Analyst', 'Worker']);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips invalid .md files and logs a warning, loading valid ones', () => {
    writeFileSync(
      join(agentsDir, 'valid.md'),
      `---
name: Valid Agent
description: valid.role.md
---
`,
    );
    writeFileSync(
      join(agentsDir, 'invalid.md'),
      `not a frontmatter file`,
    );

    const logger = makeLogger();
    const result = loadAllAgentFiles(agentsDir, logger);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Valid Agent');
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      'failed to load agent file',
      expect.objectContaining({ file: 'invalid.md' }),
    );
  });

  it('skips non-.md files silently', () => {
    writeFileSync(
      join(agentsDir, 'valid.md'),
      `---
name: Valid Agent
description: valid.role.md
---
`,
    );
    writeFileSync(join(agentsDir, 'some-skill.yaml'), 'name: skill');
    writeFileSync(join(agentsDir, 'README.txt'), 'ignore me');

    const logger = makeLogger();
    const result = loadAllAgentFiles(agentsDir, logger);
    expect(result).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('skips subdirectories', () => {
    writeFileSync(
      join(agentsDir, 'valid.md'),
      `---
name: Valid Agent
description: valid.role.md
---
`,
    );
    mkdirSync(join(agentsDir, 'subdir'));

    const logger = makeLogger();
    const result = loadAllAgentFiles(agentsDir, logger);
    expect(result).toHaveLength(1);
  });

  it('skips all files when all are invalid, returns empty array', () => {
    writeFileSync(join(agentsDir, 'bad1.md'), 'no frontmatter here');
    writeFileSync(join(agentsDir, 'bad2.md'), 'also no frontmatter');

    const logger = makeLogger();
    const result = loadAllAgentFiles(agentsDir, logger);
    expect(result).toEqual([]);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });
});
