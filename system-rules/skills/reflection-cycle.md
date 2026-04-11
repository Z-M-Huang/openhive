# Skill: Reflection Cycle

## Readiness Gates
Before executing, verify ALL of the following. If any gate fails, log a brief warning and exit without error:
1. Team is bootstrapped (`bootstrapped=1`)
2. Team has scope keywords (`scope_keywords` is non-empty)
3. All 6 required tools listed below are available in the current session

## Required Tools
- vault_get
- vault_set
- memory_save
- memory_search
- memory_list
- list_completed_tasks

## Purpose
Review recent task outcomes to identify systematic inefficiencies and propose targeted
improvements. Introspective cycle focused on accuracy and efficiency gains.

## Cycle Phases

### Phase 1: Journal Read
`vault_get("reflection:journal")` to load previous cycle notes. Check for cooldown
violations — same skill cannot be modified in consecutive cycles.

### Phase 2: Evidence Gather
`list_completed_tasks` (last 7 days, limit 50) to collect recent outcomes.
Use `memory_search` to find related learnings and patterns.
Use `memory_list` to understand current knowledge coverage.

### Phase 3: Diagnose
Identify the single highest-impact inefficiency from the evidence.
Use `vault_get` to check if this issue was already addressed in prior cycles.
Prioritize by: frequency of occurrence x severity of impact.

### Phase 4: Propose
Draft ONE specific skill or rule change targeting accuracy or efficiency improvement only.
No scope expansion allowed. The proposal must:
- Reference specific evidence from Phase 2
- Explain expected improvement
- Be testable/verifiable

### Phase 5: Apply
Apply the proposed change via the standard evolution flow (governance enforced).
Changes that add new capabilities or expand scope are rejected.

### Phase 6: Journal Update
`vault_set("reflection:journal", ...)` with updated notes including:
- This cycle's findings and proposed change
- Skills modified (for cooldown tracking)
- Timestamp

## Constraints
- ONE change per cycle — no scope expansion
- Max 15 minutes per session
- Same skill cannot be modified in consecutive cycles (cooldown — check journal)
- Changes are governance-guarded (no new capabilities)
- Only propose changes backed by evidence from completed tasks
