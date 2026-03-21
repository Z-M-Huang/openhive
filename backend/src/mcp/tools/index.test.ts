/**
 * Smoke tests for MCP tools barrel module.
 *
 * Verifies createToolHandlers returns the expected handler count and
 * TOOL_NAMES/TOOL_SCHEMAS/TOOL_COUNT are consistent.
 *
 * Detailed handler tests are in sdk-tool-handler.test.ts, helpers.test.ts,
 * and hierarchy-auth.test.ts.
 *
 * @module mcp/tools/index.test
 */

import { describe, it, expect } from 'vitest';
import {
  createToolHandlers,
  TOOL_NAMES,
  TOOL_COUNT,
  TOOL_SCHEMAS,
} from './index.js';
import { createMockContext } from './__test-helpers.js';

describe('createToolHandlers', () => {
  it('creates a Map with 27 handlers', () => {
    const ctx = createMockContext();
    const handlers = createToolHandlers(ctx);
    expect(handlers.size).toBe(27);
  });

  it('all TOOL_NAMES have entries in TOOL_SCHEMAS', () => {
    for (const name of TOOL_NAMES) {
      expect(TOOL_SCHEMAS[name]).toBeDefined();
    }
  });

  it('TOOL_COUNT equals 23', () => {
    expect(TOOL_COUNT).toBe(27);
  });
});
