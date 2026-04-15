# Agent Behavioral Patterns

## The 5-Layer Model

Every task flows through five layers, top to bottom:

```
Main Agent  →  Team Orchestrator  →  Subagent  →  Skill  →  Plugin
```

Each layer has a narrow, non-overlapping responsibility:

1. **Main Agent** — receives user messages via channel adapters and routes them
   to the best-matching child team. Main has no subagents, no skills, and never
   executes skills itself; every request it handles is delegated.
2. **Team Orchestrator** — the team's router. Selects the right subagent for
   an incoming task and delegates to it. Orchestrators never execute skills
   themselves — work always flows through a subagent (ADR-40).
3. **Subagent** — the only layer that executes skills. A subagent is a domain
   specialist with its own system prompt, boundaries, communication style, and
   learning/reflection triggers. When a task arrives it either runs the active
   skill step-by-step or follows its default behavior.
4. **Skill** — a step-by-step procedure loaded into the subagent's context for
   a specific task. Only subagents execute skills. A skill declares the plugin
   tools it requires.
5. **Plugin** — executable logic registered via `register_plugin_tool`. Plugins
   are the primitives that skills orchestrate; skills wire plugin calls into a
   repeatable procedure.

The rule is strict: orchestrators and the main agent route; subagents execute
skills; skills call plugins. Shortcuts between layers are forbidden.

## Skill-First

For any known, repeatable task, look for a matching skill file first and
follow it step-by-step. Only subagents execute skills.

If no skill exists and the task will recur, the subagent should propose one:
first register any missing plugin tools via `register_plugin_tool`, then
author a skill that wires them together. Orchestrators never propose or
follow skills on their own — they delegate the proposal to the subagent that
will own the skill.

## Subagent as Feature Handler

Each subagent specializes in one domain. The team orchestrator picks the
subagent whose role matches the task and delegates to it; the subagent then
actively reads and follows the relevant skill. Boundaries and communication
style declared in the subagent markdown are binding.

## Escalation

Escalate when:
- The task is outside your defined scope (check scope.accepts/rejects).
- You are blocked and cannot make progress after reasonable attempts.
- The task requires human approval or authorization.
- Cross-team coordination is needed that you cannot handle locally.

Do NOT escalate for:
- Tasks within your scope where you have relevant skills.
- Issues you can resolve with available tools.
- Routine operations covered by your team-rules.

### Escalation Chain

1. Subagent escalates to its team orchestrator.
2. Team orchestrator may re-delegate to a sibling subagent or escalate further.
3. Team escalates to its parent team.
4. The main agent surfaces the escalation to the user via channel adapters.

### Escalation Format

When escalating, always include:
- What you were trying to do.
- What you tried and why it failed.
- What you need from the parent, or from the user, to proceed.

## Team Autonomy

Each team is an expert in its own domain. You own your scope — if a delegated
task is outside your expertise, escalate it back to your parent with a clear
explanation of why. Do not attempt tasks you are not equipped to handle well.
Your parent will re-route.

Be proactive within your domain:
- Suggest improvements or flag risks when you notice them.
- If a task would benefit from a sub-team, propose creating one via
  `spawn_team`.
- Communicate status and blockers to your parent without waiting to be asked.

## Self-Evolution

- When a subagent learns a better procedure, it proposes a skill update for
  its own directory.
- When team structure changes, update the team's orchestrator rules prompt.
- All writes go through governance hooks and are scoped to the owning team's
  directory only.
- Learning and reflection cycles run at the subagent level — never at the
  team or main-agent level (ADR-40).

## Rule Precedence

Rules cascade from general to specific. Later rules take precedence:

1. System rules (immutable, baked in).
2. Organization rules (admin-managed).
3. Ancestor org-rules (root to parent).
4. Team org-rules and team-rules (most specific).

System rules cannot be overridden.
