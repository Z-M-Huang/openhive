/**
 * Credential Write Guard
 *
 * Tests:
 * - Write/Edit scrubber: scrubs credentials from content, ignores short creds, passes through non-matches
 * - Bash credential guard: denies file writes with credentials, allows other usage
 */

import { describe, it, expect } from 'vitest';

import { createCredentialWriteGuard, createBashCredentialGuard } from './credential-write-guard.js';
import type { HookInput } from './types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a minimal HookInput for testing — cast through unknown like layer-4 tests. */
function hookInput(input: Record<string, unknown>): HookInput {
  return input as unknown as HookInput;
}

// ── Credential Write Guard ──────────────────────────────────────────────

describe('Credential Write Guard', () => {
  const hookOpts = { signal: AbortSignal.abort() };
  // Test-only fake credential values (NOT real secrets)
  const FAKE_CRED = 'test-placeholder-cred-not-real';
  const creds = { API_KEY: FAKE_CRED, SHORT: 'abc' };
  const getCreds = () => creds;

  describe('Write/Edit scrubber', () => {
    const guard = createCredentialWriteGuard(getCreds);

    it('scrubs credential values from Write content', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/x', content: `key=${FAKE_CRED}` }, tool_use_id: 'tu1', session_id: 's1' }),
        'tu1', hookOpts,
      );
      const out = (result as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
      expect(out?.['hookEventName']).toBe('PreToolUse');
      const updated = out?.['updatedInput'] as Record<string, unknown>;
      expect(updated?.['content']).toBe('key=[CREDENTIAL:API_KEY]');
    });

    it('scrubs credential values from Edit new_string', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '/x', old_string: 'a', new_string: `token: ${FAKE_CRED}` }, tool_use_id: 'tu2', session_id: 's1' }),
        'tu2', hookOpts,
      );
      const out = (result as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
      const updated = out?.['updatedInput'] as Record<string, unknown>;
      expect(updated?.['new_string']).toBe('token: [CREDENTIAL:API_KEY]');
    });

    it('ignores credentials shorter than 8 chars', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/x', content: 'value=abc' }, tool_use_id: 'tu3', session_id: 's1' }),
        'tu3', hookOpts,
      );
      expect(result).toEqual({});
    });

    it('passes through when no credentials match', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/x', content: 'no secrets here' }, tool_use_id: 'tu4', session_id: 's1' }),
        'tu4', hookOpts,
      );
      expect(result).toEqual({});
    });

    it('passes through for non-Write/Edit tools', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 'tu5', session_id: 's1' }),
        'tu5', hookOpts,
      );
      expect(result).toEqual({});
    });
  });

  describe('Bash credential guard', () => {
    const guard = createBashCredentialGuard(getCreds);

    it('denies Bash commands that write credentials to files', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${FAKE_CRED} > /tmp/out.txt` }, tool_use_id: 'tu6', session_id: 's1' }),
        'tu6', hookOpts,
      );
      const out = (result as Record<string, unknown>)['hookSpecificOutput'] as Record<string, unknown>;
      expect(out?.['permissionDecision']).toBe('deny');
    });

    it('allows Bash commands that use credentials without file writes', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `curl -H "Bearer ${FAKE_CRED}" https://api.example.com` }, tool_use_id: 'tu7', session_id: 's1' }),
        'tu7', hookOpts,
      );
      expect(result).toEqual({});
    });

    it('allows Bash commands without credentials', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'echo hello > /tmp/file.txt' }, tool_use_id: 'tu8', session_id: 's1' }),
        'tu8', hookOpts,
      );
      expect(result).toEqual({});
    });

    it('ignores non-Bash tools', async () => {
      const result = await guard(
        hookInput({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { content: FAKE_CRED }, tool_use_id: 'tu9', session_id: 's1' }),
        'tu9', hookOpts,
      );
      expect(result).toEqual({});
    });
  });
});
