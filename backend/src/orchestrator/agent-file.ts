/**
 * OpenHive Backend - Agent File Parser
 *
 * Provides loadAgentFile() and loadAllAgentFiles() to read and parse
 * .claude/agents/<name>.md files from a team workspace directory.
 *
 * Each agent file is a Markdown file with a YAML frontmatter block
 * between --- delimiters, followed by optional free-form content.
 *
 * YAML is parsed with { schema: 'core' } to prevent code execution
 * via custom tags (!!js/function, !!python/object, etc.). Any unresolved
 * tag warnings are treated as errors and cause rejection.
 *
 * Pattern mirrors parseSkillMarkdown() in skills.ts.
 */

import { readFileSync, readdirSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { ValidationError } from '../domain/errors.js';

// ---------------------------------------------------------------------------
// AgentFileDefinition
// ---------------------------------------------------------------------------

/**
 * Parsed representation of a .claude/agents/<name>.md file.
 *
 * Required fields: name, description.
 * Optional fields: model, tools.
 */
export interface AgentFileDefinition {
  /** Agent display name (required, non-empty). */
  name: string;
  /** Role description for the agent (required, non-empty). */
  description: string;
  /** Model tier or model name (optional). */
  model?: string;
  /** List of allowed tool names (optional). */
  tools?: string[];
}

// ---------------------------------------------------------------------------
// AgentFileLogger
// ---------------------------------------------------------------------------

/**
 * Minimal structured logger required by loadAllAgentFiles.
 */
export interface AgentFileLogger {
  warn(msg: string, data?: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// loadAgentFile
// ---------------------------------------------------------------------------

/**
 * Reads and parses a single .claude/agents/<name>.md file.
 *
 * Parsing rules:
 *   1. Reads file content as UTF-8.
 *   2. Extracts YAML frontmatter between opening --- and next --- delimiters.
 *   3. Parses frontmatter with { schema: 'core' } — disables !!js/* and
 *      similar dangerous tags. Any unresolved-tag warnings are treated as
 *      errors and cause a ValidationError to be thrown.
 *   4. Validates that 'name' and 'description' are non-empty strings.
 *   5. Validates that 'tools' (if present) is an array of strings.
 *
 * Throws:
 *   - ValidationError if the file has no frontmatter, required fields are
 *     missing, types are wrong, or dangerous YAML tags are detected.
 *   - Error (from readFileSync) if the file cannot be read.
 */
export function loadAgentFile(filePath: string): AgentFileDefinition {
  const content = readFileSync(filePath, 'utf8');
  return parseAgentFileContent(content);
}

// ---------------------------------------------------------------------------
// loadAllAgentFiles
// ---------------------------------------------------------------------------

/**
 * Reads all .md files from a .claude/agents/ directory and parses each one.
 *
 * Files that fail to parse are logged and skipped — they do not cause the
 * entire load to fail. Returns an array of successfully parsed definitions.
 *
 * Returns an empty array if the directory does not exist (ENOENT).
 *
 * @param agentsDir - absolute path to the .claude/agents/ directory
 * @param logger    - structured logger for skip warnings
 */
export function loadAllAgentFiles(
  agentsDir: string,
  logger: AgentFileLogger,
): AgentFileDefinition[] {
  let entries: Dirent<string>[];
  try {
    entries = readdirSync(agentsDir, { withFileTypes: true, encoding: 'utf8' });
  } catch (err) {
    if (isEnoent(err)) {
      return [];
    }
    throw new Error(
      `failed to read agents directory: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const definitions: AgentFileDefinition[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      continue;
    }
    const fileName = entry.name;
    if (!fileName.endsWith('.md')) {
      continue;
    }

    const filePath = join(agentsDir, fileName);
    try {
      const def = loadAgentFile(filePath);
      definitions.push(def);
    } catch (err) {
      logger.warn('failed to load agent file', {
        file: fileName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return definitions;
}

// ---------------------------------------------------------------------------
// parseAgentFileContent (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parses the string content of a .claude/agents/<name>.md file.
 *
 * Exported to allow unit tests to bypass filesystem I/O.
 */
export function parseAgentFileContent(content: string): AgentFileDefinition {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith('---')) {
    throw new ValidationError('frontmatter', 'agent file has no YAML frontmatter');
  }

  // Skip the opening '---'
  const rest = trimmed.slice(3);
  const idx = rest.indexOf('\n---');
  if (idx < 0) {
    throw new ValidationError('frontmatter', 'agent file frontmatter is not terminated');
  }

  const frontmatter = rest.slice(0, idx);

  // Parse with CORE schema: prevents !!js/function, !!python/object, etc.
  // Any unresolved-tag warnings indicate dangerous or non-standard tags.
  const doc = parseDocument(frontmatter, { schema: 'core' });

  if (doc.warnings.length > 0) {
    const firstWarning = doc.warnings[0]!.message;
    throw new ValidationError(
      'frontmatter',
      `agent file contains dangerous or unsupported YAML tags: ${firstWarning}`,
    );
  }

  if (doc.errors.length > 0) {
    const firstError = doc.errors[0]!.message;
    throw new ValidationError('frontmatter', `agent file YAML parse error: ${firstError}`);
  }

  const parsed: unknown = doc.toJS();

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ValidationError('frontmatter', 'agent file frontmatter must be a mapping object');
  }

  const obj = parsed as Record<string, unknown>;

  // Validate required field: name
  if (typeof obj['name'] !== 'string' || obj['name'] === '') {
    throw new ValidationError('name', 'agent file missing required field: name');
  }

  // Validate required field: description
  if (typeof obj['description'] !== 'string' || obj['description'] === '') {
    throw new ValidationError('description', 'agent file missing required field: description');
  }

  const def: AgentFileDefinition = {
    name: obj['name'],
    description: obj['description'],
  };

  // Optional field: model
  if (obj['model'] !== undefined) {
    if (typeof obj['model'] !== 'string') {
      throw new ValidationError('model', 'agent file field "model" must be a string');
    }
    def.model = obj['model'];
  }

  // Optional field: tools
  if (obj['tools'] !== undefined) {
    if (!Array.isArray(obj['tools'])) {
      throw new ValidationError('tools', 'agent file field "tools" must be an array');
    }
    for (const item of obj['tools'] as unknown[]) {
      if (typeof item !== 'string') {
        throw new ValidationError(
          'tools',
          `agent file field "tools" must contain only strings, got: ${typeof item}`,
        );
      }
    }
    def.tools = obj['tools'] as string[];
  }

  return def;
}

// ---------------------------------------------------------------------------
// isEnoent (internal)
// ---------------------------------------------------------------------------

/**
 * Returns true if the error is a file-not-found (ENOENT) condition.
 */
function isEnoent(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
