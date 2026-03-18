---
paths:
  - "backend/src/executor/**/*.ts"
---

# Executor Rules

- Root-local agents run via Claude Agent SDK `query()` API. Non-root container agents use the legacy child-process mode.
- Always pass `sessionId: undefined` — never resume SDK sessions (causes conflicts)
- Cross-message context comes from Tier 2 (MEMORY.md + daily logs) and Tier 3 (task history)
- System prompt is enriched with: memory → daily logs → task history → tool catalog → behavioral instructions
- Post-task auto-save: every completed task appends to daily log (best-effort, must not affect task completion)
- Personal info auto-extraction: regex-based, deterministic, supplements LLM save_memory calls
- Query timeout: 5 minutes via AbortController
- The `memoryFileWriter` callback must match the same workspace path used for memory injection
- `_resolveTeamSlug()` currently returns 'main' — update when multi-team dispatch is implemented
