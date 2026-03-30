/**
 * Local hook types — replaces @anthropic-ai/claude-agent-sdk hook types.
 *
 * These are the minimal shapes actually used by the hook source files.
 * The SDK is being removed in favor of Vercel AI SDK 6.
 */

/**
 * Input passed to a hook callback.
 * Union of all hook event inputs, but in practice hooks only read
 * the fields they care about.
 */
export interface HookInput {
  readonly hook_event_name: string;
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly tool_use_id?: string;
  readonly tool_response?: unknown;
  readonly session_id?: string;
  readonly transcript_path?: string;
  readonly cwd?: string;
  [key: string]: unknown;
}

/** Alias for PreToolUse-specific input. */
export type PreToolUseHookInput = HookInput & {
  readonly hook_event_name: 'PreToolUse';
  readonly tool_name: string;
  readonly tool_input: unknown;
  readonly tool_use_id: string;
};

/**
 * Output returned from a hook callback.
 */
export interface HookJSONOutput {
  hookSpecificOutput?: {
    hookEventName?: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
    additionalContext?: string;
  };
  continue?: boolean;
  suppressOutput?: boolean;
  stopReason?: string;
  decision?: string;
  systemMessage?: string;
  reason?: string;
}

/**
 * Hook callback function signature.
 */
export type HookCallback = (
  input: HookInput,
  toolUseId: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;

/**
 * Hook callback matcher — groups hooks with a regex matcher pattern.
 */
export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
}

/**
 * Permission result returned by canUseTool.
 */
export type PermissionResult = {
  behavior: 'allow';
  updatedInput?: Record<string, unknown>;
  toolUseID?: string;
} | {
  behavior: 'deny';
  message: string;
  interrupt?: boolean;
  toolUseID?: string;
};

/**
 * canUseTool callback signature.
 */
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    signal: AbortSignal;
    toolUseID: string;
    [key: string]: unknown;
  },
) => Promise<PermissionResult>;
