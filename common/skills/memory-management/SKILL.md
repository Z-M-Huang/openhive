---
name: memory-management
description: "How to create, update, and curate persistent memory across tasks and sessions"
allowed-tools:
  - save_memory
  - recall_memory
---

## When to Apply

Use this skill throughout task execution to build and maintain your persistent memory. Memory enables you to learn from experience, avoid repeating mistakes, and accumulate domain knowledge over time.

Apply memory operations in these situations:

- **Task start:** Recall relevant memories before beginning work to benefit from past context.
- **During execution:** Save important observations, patterns, and intermediate findings as daily log entries.
- **Task completion:** Promote key learnings to curated memory and archive stale entries.
- **Proactive checks:** During idle-time checks, review and consolidate daily logs into curated memory.

## Memory Types

### Curated Memory (MEMORY.md)

Your curated memory is loaded automatically into your system prompt at the start of every task. It represents your distilled, long-term knowledge.

- **Format:** Overwrite. Each save replaces the entire file.
- **Content:** Distilled patterns, preferences, key decisions, and critical context.
- **Size:** Keep under 200 lines. Curated memory is injected into every task context, so brevity matters.
- **Quality:** Every line should earn its place. If an entry has not been useful in 5+ tasks, consider removing it.

### Daily Logs (YYYY-MM-DD.md)

Daily logs are chronological records of specific observations and events.

- **Format:** Append-only. New entries are added to the end.
- **Content:** Specific observations, error patterns, task outcomes, and raw findings.
- **Retention:** Daily logs accumulate over time. They are the raw material for curated memory.

## Steps

### 1. Recall Before Acting

At the start of any task, check your memory for relevant context:

```
Use recall_memory with a query related to the current task.
Examples:
  - query: "database migration patterns"
  - query: "error handling for API timeouts"
  - query: "team preferences for code style"
```

Your curated memory (MEMORY.md) is already in your system prompt, so `recall_memory` is most useful for searching daily logs and finding specific past entries.

### 2. Save Observations During Work

As you work, save noteworthy observations to your daily log:

```
Use save_memory with:
  - content: "Discovered that the payment API returns 429 when called more
    than 10 times per minute. Added exponential backoff with max 3 retries."
  - memory_type: "daily"
```

What to save as daily entries:
- Error patterns and their solutions
- API behaviors or quirks discovered
- Task outcomes (success/failure and why)
- Tool usage patterns that worked well
- Dependencies or blockers encountered

What NOT to save:
- Routine, expected behavior (no signal)
- Exact copies of task prompts or outputs (too verbose)
- Temporary state that will not be relevant tomorrow

### 3. Curate After Completing Tasks

After completing a significant task or series of related tasks, update your curated memory:

```
Use save_memory with:
  - content: <updated curated memory content>
  - memory_type: "curated"
```

Curation process:
1. Review recent daily log entries (last 3-5 days).
2. Identify patterns, recurring themes, and key learnings.
3. Distill them into concise, actionable entries.
4. Read your current MEMORY.md content (from your system prompt).
5. Merge new learnings with existing curated entries.
6. Remove entries that are no longer relevant or accurate.
7. Write the updated curated memory.

### 4. Archive Stale Entries

During curation, actively prune your curated memory:

- **Remove** entries about one-time issues that have been permanently fixed.
- **Remove** entries about temporary states (e.g., "API is down for maintenance").
- **Consolidate** multiple related entries into single, comprehensive ones.
- **Update** entries that have become more nuanced with experience.

## Curated Memory Structure

Organize your MEMORY.md with clear sections:

```markdown
# Key Patterns
- [Pattern entries -- recurring situations and best responses]

# Domain Knowledge
- [Domain-specific facts learned from experience]

# Team Preferences
- [Preferences and conventions of the team and its members]

# Known Issues
- [Active issues, workarounds, and their status]

# Tool Notes
- [Tool-specific behaviors, quirks, and best practices]
```

## Quality Guidelines

- **Be specific.** "API is slow" is not useful. "Payment API P95 latency is 2.3s under load; batch requests when possible" is useful.
- **Be actionable.** Each entry should help your future self make a better decision.
- **Be current.** Stale entries are worse than no entries -- they cause incorrect assumptions.
- **Be concise.** Your curated memory is injected into every task. Every word costs context window space.
