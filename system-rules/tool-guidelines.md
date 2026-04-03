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
