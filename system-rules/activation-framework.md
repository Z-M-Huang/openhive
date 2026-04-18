# Activation Framework (ADR-44 / Tier 1)

This document captures the rationale behind OpenHive's activation model: how
teams decide when to run work, why continuous sessions are impossible, and how
window triggers provide continuity through periodic rounds plus memory cursors.

## Why there are no continuous sessions

The Vercel AI SDK's `streamText` has **no pause/resume primitive**. Once a
session begins, it runs until the model stops producing tokens or the stream
terminates — it cannot pause waiting for an external event and it cannot
resume a previously closed stream against the same turn.

Separately, the **Anthropic API has an idle timeout** on its streaming
endpoint: if no tokens arrive on the stream for roughly 60 seconds, the
connection is terminated. So even if we wanted to keep a session open and
idle-wait for something external, the provider would drop the stream out
from under us.

Together, these two facts mean OpenHive **cannot keep a session running
indefinitely to watch for events**. Any activation that needs to react to
clock time, external events, or polled watch conditions has to be modeled as
a sequence of independent sessions, each started from the outside.

## The trigger engine vs on-demand rule of thumb

This gives a clean activation taxonomy:

- **Clock / event / watch work belongs in the trigger engine.** If the work is
  driven by "when X happens" or "every N minutes" or "during this window" —
  the trigger engine owns it. Each firing is a fresh session.
- **User-now work stays on-demand.** If a human just spoke to the team (or a
  peer team just delegated to it), the team responds inline — no trigger
  wrapping, no cursor management.

A shorthand: if the reason for running is "the clock said so" or "something
watched noticed a change", the trigger engine is involved. If the reason is
"a user or peer is waiting for a reply right now", run on-demand.

## Window triggers — continuity without a continuous session

`window` triggers fake continuity by scheduling **periodic tick rounds** inside
a larger time window. Each tick is an independent session; between ticks the
team persists its progress in memory under canonical cursor keys.

Cursors are **namespaced** `<subagent_name>:<cursor_name>` so multiple
subagents can keep independent cursors without stepping on each other. Three
canonical keys are defined:

- `last_scan_cursor` — the highest-watermark the subagent has already
  processed on its primary feed. Read at start of a tick, write at end.
- `last_event_id` — the most recent event ID the subagent has acted on.
  Used for dedup across ticks and across window boundaries.
- `window_start_summary` — a compact recap of what has happened so far in
  the current window, so the subagent can resume without re-scanning from
  scratch.

### Cursor discipline: read-at-start / write-at-end

Every window tick **reads all three cursor keys at the very start of its
session** (via `memory_search`, `memory_list`, or the auto-injected memory
block) and **writes them back at the end** (via `memory_save` with a
supersede reason). This is the only way to
carry state between independent sessions: the SDK forgets everything on
session close, memory does not.

A subagent that only reads cursors will drift — it will re-process the same
items every tick. A subagent that only writes cursors will ignore prior
progress and re-scan from scratch every tick. Both halves of the protocol are
load-bearing.

### Cursor example

A `planner` subagent running a window trigger on a message feed would use:

```
planner:last_scan_cursor      → "2026-04-17T19:00:00Z"
planner:last_event_id         → "msg_01HX...Z"
planner:window_start_summary  → "Window opened at 18:00. Processed 12 msgs; 3 flagged."
```

On each tick, the subagent reads these three, does incremental work from
`last_scan_cursor` forward, updates `window_start_summary` with what it just
did, and writes all three back.

## Consequences for agent authors

1. Do not try to keep a session open to wait for an event. Model it as a
   trigger plus cursors.
2. Do not reinvent cursor storage inside tool code. Use `memory_*` tools with
   the namespaced keys above.
3. Do not mix activation modes: if a team has a window trigger watching a
   feed, do not also have it respond on-demand to the same feed — pick one.
4. For user-facing "right now" requests, run on-demand. Do not add a trigger
   layer for things a user is actively waiting on.

## Related contracts

- `system-rules/tool-guidelines.md` — activation decision framework and the
  no-op tick contract consumed by the trigger engine.
- `system-rules/task-workflow.md` — how triggered sessions interact with the
  task queue.
- ADR-41 — concurrency classification (daily vs org) applied to triggered
  tool calls.
- ADR-42 — `window` trigger state machine.
- ADR-44 — the tier-1 promotion of this activation framework.
