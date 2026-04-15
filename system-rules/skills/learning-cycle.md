# Skill: Learning Cycle

## Readiness Gates
Before executing, verify ALL of the following. If any gate fails, log a brief warning and exit without error:
1. Team is bootstrapped (`bootstrapped=1`)
2. Team has scope keywords (`scope_keywords` is non-empty)
3. All 7 required tools listed below are available in the current session

## Required Tools
- web_fetch
- vault_set
- vault_get
- memory_save
- memory_search
- memory_list
- list_completed_tasks

## Purpose
Capture reusable knowledge after completing non-trivial tasks. Uses journaled learning with
corroboration requirements to ensure high-quality, verified insights.

## Cycle Phases

### Phase 1: Observe — Topic Coverage
Review what happened during recent tasks. Use `list_completed_tasks` output (if available)
and conversation context. Note inputs, outputs, errors, and unexpected behavior.
Track which scope keywords have been covered vs. not yet explored.

### Phase 2: Source Visitation
Use `memory_search` and `memory_list` to check what the team already knows about the topic.
Avoid re-learning established patterns. Use `web_fetch` for web discovery to find
authoritative references that support or challenge observations.

### Phase 3: Reflect + Corroborate
Identify what went well, what went wrong, and why. Look for root causes, not symptoms.
Cross-reference with at least 3 sources (memory entries, web references, prior task outcomes)
to corroborate each insight. Assign confidence:
- **high** — corroborated by 3+ independent sources
- **medium** — corroborated by 2 sources or strong single-source evidence
- **low** — single observation, no corroboration (do NOT store)

### Phase 4: Generalise
Extract reusable patterns, rules, or heuristics from the reflection.
Ask: "If I saw a similar task again, what would I do differently?"
Only proceed with confidence >= medium.

### Phase 5: Record
Persist the insight using `memory_save`. Use descriptive keys (e.g., `lesson:api-retry-backoff`).
Include concrete examples, not vague advice. Record confidence level and source references.
Store the journal entry via `vault_set("learning:{team}:{subagent}:journal", ...)` — the key
must be per-subagent so concurrent cycles within the same team do not overwrite each other.
Include cycle timestamp, topics covered, and insights generated.

### Phase 6: Verify
Re-read the saved memory to confirm it is accurate and actionable.
Delete or correct anything misleading.

## Constraints
- Max 5 learnings per session
- 30-minute session budget
- Only store insights with confidence >= medium
- Use descriptive memory keys (e.g., `lesson:api-retry-backoff`)
- Vault entries use 90-day expiry where supported
