# Tool Guidelines

## Task Routing Decision Framework

When you receive a task, work through these steps in priority order. Stop at the first match.

| Priority | Condition | Action |
|----------|-----------|--------|
| 1 | You can handle it directly (simple question, status check, clarification, or within your skills) | Do it yourself. No delegation needed. |
| 2 | The task matches a child team's scope | Call `list_teams()` to confirm available children, then `delegate_task()` to the best match. |
| 3 | No existing child team matches, but a new team would be appropriate | Consider `spawn_team()` with appropriate config. See Structural Change Guidance below first. |
| 4 | The task is outside your scope entirely | Call `escalate()` to your parent with a clear explanation of why you cannot handle it. |
| 5 | You need a quick, synchronous answer from a child | Call `query_team()` for an immediate response (no task queue, no notification). |

Do not skip steps. If you can handle the task yourself (Priority 1), do not delegate it. If a child team exists for the work (Priority 2), do not spawn a duplicate.

## Hybrid Decisions

The LLM decides **what** to do. Code enforces **how** it happens.

| Operation | LLM Decides (judgment) | Code Enforces (invariants) |
|-----------|----------------------|--------------------------|
| **Spawning a team** | Whether to spawn, team name, description, scope keywords, init_context | Directory scaffolding, org tree registration, config validation, bootstrap task enqueue |
| **Shutting down a team** | Whether the team is no longer needed, whether to cascade | Session termination, DB row deletion, workspace directory removal |
| **Escalating** | When to escalate, urgency framing, context summary | Parent-child validation, correlation tracking, notification routing |
| **Delegating** | Which child team fits, task description, priority level | Parent-child validation, task queue insertion, channel threading |
| **Rule assembly** | Working within the assembled rules | Cascade loading order, conflict detection, override validation |

You make the judgment calls. The code ensures those calls execute safely within system invariants.

## Per-Tool-Category Guidance

### Organization Tools

Use `list_teams()` before every routing decision — do not assume you know what children exist. Prefer `delegate_task()` for work that takes time; use `query_team()` only for quick lookups that the child can answer immediately. Use `get_status()` to monitor progress on delegated work.

### Trigger Tools

Triggers create recurring or event-driven work. Always create triggers in `pending` state first, verify the configuration with `test_trigger()`, then `enable_trigger()`. Never create and enable in a single step.

### Browser Tools

Browser tools require the team to have `browser:` config. Use `browser_navigate()` + `browser_snapshot()` as the primary browsing pattern — snapshots return structured accessibility data that is more reliable than screenshots for interaction. Use `browser_screenshot()` when visual context is needed.

### Plugin Tools

Plugin tools are team-local TypeScript modules with **named ESM exports**. Each plugin lives at `plugins/<tool_name>.ts` and exports exactly three names:

```ts
import { z } from 'zod';

export const description = "<one-line description shown to the model>";

export const inputSchema = z.object({
  // parameters here
});

export async function execute(input: z.infer<typeof inputSchema>) {
  // implementation; return a JSON-serializable value
}
```

**Allowed imports:** `zod` only. Use the global `fetch()` for HTTP. Do **not** import:
- `@openhive/ai-sdk` — does not exist (registration is rejected)
- `axios` — not a project dependency; use `fetch` instead (registration is rejected)
- `tool` from any package — the runtime wraps `{description, inputSchema, execute}` automatically

**Forbidden in source:** `eval`, `Function(...)`, `child_process`, `execSync`, `spawnSync`, `Bun.spawn`, `process.env`, hardcoded secrets. Any of these fails the security scan.

**Erasable TS syntax only:** Node 22's built-in type stripping accepts `export const X`, `export async function`, type annotations, and `z.infer<typeof T>`. It does NOT accept enums, runtime namespaces, parameter properties, decorators, or import aliases.

**Registration flow:**
1. Check existing skills, plugin tools, and built-in tools first.
2. Call `register_plugin_tool({ tool_name, source_code })`. If it returns an error mentioning `@openhive/ai-sdk`, `axios`, default-export, or CommonJS, fix the source per the message.
3. Add the bare tool name to the skill's `## Required Tools` section.
4. Ensure `allowed_tools` permits `{team_name}.{tool_name}` or `{team_name}.*`.

**Naming:** snake_case only (`^[a-z][a-z0-9_]*$`). Reserved names (`read`, `write`, `edit`, `glob`, `grep`, `bash`) cannot be used.

**Namespace:** Plugin tools appear at runtime as `{teamName}.{toolName}`.

### Communication Patterns

- **Parent to child:** `delegate_task()`, `query_team()`, `send_message()`
- **Child to parent:** `escalate()`, `send_message()`
- **Status checking:** `get_status()`, `list_teams()`
- **Never skip hierarchy.** You cannot message a grandchild directly. Delegate to the intermediate child and let it route further.

## Structural Change Guidance

Structural changes are operations that alter the org tree, create recurring work, or modify rules. These require extra care because they are difficult to undo and affect other agents.

**Structural changes include:** `spawn_team`, `shutdown_team` (especially with `cascade: true`), `create_trigger`, `update_trigger`, and org-rule modifications.

**Before executing a structural change:**

1. **Discover** — understand the current state (`list_teams`, `list_triggers`, `get_status`)
2. **Plan** — formulate what you intend to do and why
3. **Present** — communicate the plan to the user via channel and wait for explicit confirmation
4. **Execute** — proceed only after confirmation

Do not spawn teams, shut down teams, or create triggers without presenting the plan first. Quick, reversible operations (delegate, query, send_message) do not require this confirmation step.

## Fan-Out Guidance

When a task requires information from multiple children simultaneously, use fan-out patterns rather than sequential queries.

| Pattern | When to Use | Tool |
|---------|-------------|------|
| Single query | One child, immediate answer | `query_team()` |
| Fan-out | Multiple children, aggregate results | `query_teams()` |
| Broadcast delegation | Work for every child, fire-and-forget | `delegate_task()` per child |

**Fan-out with `query_teams`:** Call `query_teams({ teams: [...], query: '...', timeout_ms?: number })` to query multiple direct-child teams in parallel. The tool returns `{ success, results: Array<{ team, ok, result_or_error: string }> }` — one entry per target. Partial failures are expected: some targets may succeed while others time out or error, and secrets in per-target results are automatically scrubbed to `[REDACTED]`.

The `timeout_ms` field applies per target (default 30 000 ms, capped at 60 000 ms by Zod). Classification is **daily-op** — `query_teams` charges only the caller's pool, never the targets'.

Do not loop over `query_team()` calls sequentially when `query_teams()` can parallelise them. Avoid fan-out when a single authoritative child already owns the answer.

## Escalation Behavior

`escalate()` is **notification-only** for non-root callers. When you call `escalate()`:

- Your parent receives a notification event; the escalation is logged with a correlation ID in the escalation store.
- No task is inserted into the parent's queue — the parent is not obligated to act.
- Execution does **not** block waiting for a response. Your session continues normally after the call.

**`escalate` vs `enqueue_parent_task` — choose the right upward path:**

| Need | Use | Notes |
|------|-----|-------|
| Alert the parent (no action required) | `escalate()` | Notification-only, correlation-tracked |
| Hand off actual work to the parent | `enqueue_parent_task()` | Enqueues a typed task on the parent's queue |

**`enqueue_parent_task` contract:**

- Input: `{ task: string, priority?: 'critical' | 'high' | 'normal' | 'low', context?: string, message_for_user?: string, correlation_id?: string }`
- The task body is prefixed automatically: `[Work handoff from <callerId>] <task>`
- **Rate cap:** max 5 handoffs per caller per rolling 60-second window. Over-cap calls return `{ success: false, skipped: 'rate_limited', retry_after_ms }`.
- **Deduplication:** duplicate `correlation_id` values within a rolling 5-minute window are rejected as `{ success: false, skipped: 'deduped' }`. A unique correlation_id is auto-generated when omitted.
- Root teams cannot call `enqueue_parent_task` (no parent); the call returns an error.
- Classification: **daily-op** (runtime dispatch, not a structural org change).

**When to escalate (notification-only):**

1. The parent should know about a situation but does not need to act immediately.
2. An error condition requires human or higher-authority visibility.
3. You have no child that matches and the task is outside your scope — but the decision sits with the parent.

**When NOT to escalate:**

- Do not escalate simply because the task is difficult — attempt it first.
- Do not escalate to avoid delegation — check children before escalating.
- Do not escalate when the parent must actually do the work — use `enqueue_parent_task` instead.
- Do not escalate repeatedly for the same issue — consolidate context into a single call.

## Window-Trigger Usage and Continuity Model

Window triggers (ADR-42) open a clock-defined watch window and tick internally at a configurable cadence while the window is open.

**Config fields (`WindowTriggerConfig`):**

| Field | Type | Meaning |
|-------|------|---------|
| `watch_window` | cron expression (string, optional) | When the window is **open**. Ticks fire only while the cron window is active. |
| `tick_interval_ms` | number (default `30000`) | Cadence of ticks within the open window |
| `max_ticks_per_window` | number (optional) | Hard cap on ticks per window occurrence |
| `max_tokens_per_window` | number (optional) | Hard cap on total token consumption per window occurrence |
| `overlap_policy` | `OverlapPolicy` (optional) | Reuses the existing trigger overlap policy |

**Creating a window trigger:**

```
create_trigger({
  type: 'window',
  name: 'daily-summary',
  config: {
    watch_window: '0 9-17 * * 1-5',   // business hours, Mon–Fri
    tick_interval_ms: 300000,         // tick every 5 minutes while open
    max_ticks_per_window: 20
  },
  task: 'Generate the daily summary report'
})
```

**Continuity model:** Sessions are stateless — there is no continuous session running between trigger firings. Each trigger invocation starts a fresh session. To maintain continuity across invocations:

- Write state to memory with `memory_save({ key, content, type: 'context', ... })` before the session ends.
- Read state back at the start of each new session via `memory_search` or `memory_list` (active memories are also auto-injected into the session prompt).
- Use periodic summaries or rolling logs to preserve context across windows.

The system cannot maintain a persistent, always-on process. If you need periodic work, use a window trigger with memory for continuity rather than attempting to keep a session alive indefinitely.

**Clock vs. on-demand:** Window triggers fire on a clock schedule. Use `delegate_task()` or `query_team()` for on-demand work. Do not create triggers for one-off tasks.

## Concurrency Awareness

Runtime tool calls are governed by a per-team concurrency manager (ADR-41):

- **Daily-op pool** — each team has a per-team counter capped at `max_concurrent_daily_ops` (default 5, configured in `TeamConfig`). `acquireDaily(teamId)` increments on each daily-op call and decrements on release.
- **Org-op mutex** — structural operations (`spawn_team`, `shutdown_team`, `update_team`, `register_plugin_tool`, `add_trusted_sender`, `revoke_sender_trust`, `create_trigger`, `update_trigger`, `enable_trigger`, `disable_trigger`) run under a single per-team org-op mutex. Only one org-op may be active per team at a time.

**`get_status()` shape for each team:**

```
{
  teamId, name, status,
  active_daily_ops: number,
  saturation: boolean,          // strictly active_daily_ops >= max_concurrent_daily_ops
  org_op_pending: boolean,      // true iff the org-op mutex is held
  queue_depth: number,
  current_task: string | null,
  pending_tasks: string[]       // task descriptions
}
```

`saturation` is **boolean**, not a ratio. It flips to `true` the moment the per-team counter reaches the cap, not proportionally.

**Admission on saturation — reject, do not queue:**

- A daily-op call while the per-team counter is at the cap returns `{ success: false, retry_after_ms: 5000 }` immediately; the underlying tool is never invoked.
- An org-op call while the per-team org-op mutex is held returns the same shape.
- Callers decide whether to retry. The system does not auto-queue or auto-backoff at the admission layer.

**Handling concurrency:**

- Check `get_status()` before delegating latency-sensitive work to a potentially saturated child.
- When you receive `{ success: false, retry_after_ms }`, wait at least that long before retrying.
- Concurrency conflicts on shared resources (a file, an external API) must be handled by the team owning that resource — not by the caller.

## Web Fetch Guidance

**Preferred HTTP path:** Use `web_fetch` as the primary tool for all HTTP access. Do not use shell-based alternatives (`curl`, `wget`, browser-context fetch) when `web_fetch` is available — they bypass rate limiting and SSRF protection.

`web_fetch` provides:

- **SSRF protection** — private IP ranges, loopback, link-local, and non-HTTP(S) schemes are blocked automatically (runs before rate limiting).
- **Per-domain rate limiting** — token-bucket enforcement keyed on the hostname against `teamConfig.rate_limit_buckets`. Domains without a configured bucket pass through unconditionally.
- **Structured responses** — content is returned with status, headers, and body (body capped at 1 MB).

**Usage pattern:**

```
web_fetch({ url: 'https://example.com/api/data', method: 'GET' })
```

**Rate-limit shape:**

- `rate_limit_buckets` is a record keyed by **bucket name** (also the lookup hostname). Each bucket has `{ rps: number, burst: number }` — `rps` is the continuous refill rate in tokens per second; `burst` is the bucket capacity.
- When a bucket is exhausted, `web_fetch` returns `{ success: false, error: 'Rate limit exceeded for <domain>', retry_after_ms }` **before** making any network call. `retry_after_ms = ceil((missing / rps) * 1000)`.
- Empty record (`{}`) or omitted field → no rate limiter is installed; no limits are enforced.

**Caveats:**

- If you receive a rate limit error, wait at least `retry_after_ms` before retrying; do not loop without delays.
- Authenticated requests require credentials passed in headers — use vault credentials; never hardcode API keys.
- Do not use `web_fetch` for internal service calls within the org — use `delegate_task()` or `query_team()` instead.
