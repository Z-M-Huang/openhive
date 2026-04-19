/**
 * ADR-41 — Tool concurrency classification + admission wrapper.
 *
 * Extracted from `tool-assembler.ts` to keep that file under the 300-line
 * gate. The two public surfaces (`TOOL_CLASSIFICATION`, `withConcurrencyAdmission`)
 * are re-exported by `tool-assembler.ts` for back-compat with existing tests
 * and the rest of the codebase that imports them from that path.
 */

import type { IConcurrencyManager } from '../domain/interfaces.js';

/**
 * Whether a tool is a high-volume daily operation or a low-frequency structural
 * org operation.  See ADR-41 for the full classification rationale.
 */
export type ToolClass = 'daily' | 'org';

/**
 * Authoritative classification table (ADR-41, AC-56, AC-57).
 *
 * Disputed tools resolved:
 *  - query_teams       → daily  (read-only query; charged to caller pool)
 *  - enqueue_parent_task → daily (runtime dispatch; not a structural org change)
 *  - create_trigger    → org   (structural config creation)
 *  - update_trigger    → org   (structural config modification)
 *  - disable_trigger   → org   (structural config change; symmetric with enable_trigger)
 *  - enable_trigger    → org   (structural config change; consistent with disable_trigger)
 */
export const TOOL_CLASSIFICATION: Record<string, ToolClass> = {
  // ── Daily ops — high-volume runtime operations (AC-56) ───────────────────
  delegate_task: 'daily',
  enqueue_parent_task: 'daily',  // ADR-41: runtime dispatch; not structural org change
  escalate: 'daily',
  get_status: 'daily',
  list_completed_tasks: 'daily',
  list_teams: 'daily',
  list_trusted_senders: 'daily',
  query_team: 'daily',
  query_teams: 'daily',          // ADR-41: read-only query; charges to caller pool
  search_skill_repository: 'daily',
  send_message: 'daily',
  web_fetch: 'daily',
  // Memory tools
  memory_delete: 'daily',
  memory_list: 'daily',
  memory_save: 'daily',
  memory_search: 'daily',
  // Vault tools
  vault_delete: 'daily',
  vault_get: 'daily',
  vault_list: 'daily',
  vault_set: 'daily',
  // Browser tools
  browser_click: 'daily',
  browser_close: 'daily',
  browser_go_back: 'daily',
  browser_go_forward: 'daily',
  browser_navigate: 'daily',
  browser_screenshot: 'daily',
  browser_snapshot: 'daily',
  browser_type: 'daily',
  // Trigger read/test ops (non-structural)
  list_triggers: 'daily',
  test_trigger: 'daily',

  // ── Org ops — structural, low-frequency configuration changes (AC-57) ────
  add_trusted_sender: 'org',
  register_plugin_tool: 'org',
  revoke_sender_trust: 'org',
  shutdown_team: 'org',
  spawn_team: 'org',
  update_team: 'org',
  // Trigger structural ops: creation/modification of trigger config is an org-level change
  create_trigger: 'org',   // ADR-41: structural config creation
  disable_trigger: 'org',  // ADR-41: structural config change
  enable_trigger: 'org',   // ADR-41: consistent with disable_trigger
  update_trigger: 'org',   // ADR-41: structural config modification
};

/**
 * Wrap a tool's `execute` function with concurrency admission control (ADR-41).
 *
 * The wrapper:
 * 1. Classifies the tool via TOOL_CLASSIFICATION.
 * 2. Calls acquireDaily / acquireOrg on the manager before execution.
 * 3. On slot denial, returns `{ success: false, retry_after_ms }` immediately.
 * 4. On slot grant, executes the original tool and releases the slot in `finally`.
 *
 * Saturation policy (AC-58): reject + retry_after_ms — no queuing.
 * Pool ownership: determined by `resolveOwner(input, callerId)`.
 *
 * Tools not present in TOOL_CLASSIFICATION bypass admission (no slot charged).
 */
export function withConcurrencyAdmission<T extends object>(
  toolName: string,
  tool: T,
  mgr: IConcurrencyManager,
  resolveOwner: (input: unknown, callerId: string) => string,
): T {
  const a = tool as Record<string, unknown> & { execute?: (...args: unknown[]) => Promise<unknown> };
  if (!a.execute) return tool;

  const cls = TOOL_CLASSIFICATION[toolName];
  if (!cls) return tool; // unclassified tools are not subject to admission

  const originalExecute = a.execute;

  const wrappedExecute = async (...args: unknown[]): Promise<unknown> => {
    const [input] = args;
    // callerId '' is a sentinel; resolveOwner closures capture the real teamName
    const ownerId = resolveOwner(input, '');

    if (cls === 'daily') {
      const slot = mgr.acquireDaily(ownerId);
      if (!slot.ok) {
        return { success: false, retry_after_ms: (slot as { ok: false; retry_after_ms: number }).retry_after_ms };
      }
      try {
        return await originalExecute(...args);
      } finally {
        mgr.releaseDaily(ownerId);
      }
    } else {
      const slot = mgr.acquireOrg(ownerId);
      if (!slot.ok) {
        return { success: false, retry_after_ms: (slot as { ok: false; retry_after_ms: number }).retry_after_ms };
      }
      try {
        return await originalExecute(...args);
      } finally {
        mgr.releaseOrg(ownerId);
      }
    }
  };

  return { ...a, execute: wrappedExecute } as unknown as T;
}
