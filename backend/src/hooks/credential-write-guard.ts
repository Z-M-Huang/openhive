/**
 * Credential write guard — PreToolUse hooks that prevent credential
 * values from being persisted to disk.
 *
 * Two hooks:
 * 1. Write/Edit scrubber: replaces credential values with [CREDENTIAL:KEY] placeholders
 * 2. Bash guard: denies Bash commands that write credentials to files
 */

import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';

/**
 * Create a PreToolUse hook that scrubs credential values from Write/Edit content.
 * Uses `updatedInput` to rewrite tool inputs before execution.
 */
export function createCredentialWriteGuard(
  getCredentials: () => Record<string, string>,
): HookCallback {
  return (input) => {
    // PreToolUse hooks are only called with PreToolUseHookInput
    if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
    const preInput = input as PreToolUseHookInput;

    const creds = getCredentials();
    const entries = Object.entries(creds).filter(([, v]) => v.length >= 8);
    if (entries.length === 0) return Promise.resolve({});

    const toolInput = preInput.tool_input as Record<string, unknown>;
    let content: string | undefined;
    let field: string = '';

    if (preInput.tool_name === 'Write' && typeof toolInput['content'] === 'string') {
      content = toolInput['content'];
      field = 'content';
    } else if (preInput.tool_name === 'Edit' && typeof toolInput['new_string'] === 'string') {
      content = toolInput['new_string'];
      field = 'new_string';
    }

    if (!content) return Promise.resolve({});

    let scrubbed = content;
    for (const [key, value] of entries) {
      scrubbed = scrubbed.replaceAll(value, `[CREDENTIAL:${key}]`);
    }

    if (scrubbed === content) return Promise.resolve({});

    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        updatedInput: { ...toolInput, [field]: scrubbed },
      },
    });
  };
}

/** File-write shell patterns that indicate a credential is being persisted to disk. */
const FILE_WRITE_PATTERNS = /[>]{1,2}\s|tee\s|cat\s.*>\s|printf\s.*>\s/;

/**
 * Create a PreToolUse hook that denies Bash commands which write credential
 * values to files. Non-file-write commands (curl, wget, etc.) are allowed.
 */
export function createBashCredentialGuard(
  getCredentials: () => Record<string, string>,
): HookCallback {
  return (input) => {
    // PreToolUse hooks are only called with PreToolUseHookInput
    if (input.hook_event_name !== 'PreToolUse') return Promise.resolve({});
    const preInput = input as PreToolUseHookInput;
    if (preInput.tool_name !== 'Bash') return Promise.resolve({});

    const creds = getCredentials();
    const entries = Object.entries(creds).filter(([, v]) => v.length >= 8);
    if (entries.length === 0) return Promise.resolve({});

    const toolInput = preInput.tool_input as Record<string, unknown>;
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : undefined;
    if (!command) return Promise.resolve({});

    // Only block if command contains BOTH a credential value AND a file-write pattern
    const hasCredential = entries.some(([, value]) => command.includes(value));
    if (!hasCredential) return Promise.resolve({});

    const hasFileWrite = FILE_WRITE_PATTERNS.test(command);
    if (!hasFileWrite) return Promise.resolve({});

    const matchedKeys = entries.filter(([, v]) => command.includes(v)).map(([k]) => k);
    return Promise.resolve({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Credential guard: Bash command writes credential value(s) [${matchedKeys.join(', ')}] to file. Use get_credential at point of use instead.`,
      },
    });
  };
}
