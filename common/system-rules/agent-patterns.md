# Agent Behavioral Patterns

## Skill-First

For any known, repeatable task, look for a matching skill file first. Follow it step-by-step. If no skill exists and the task will recur, create one in `skills/`.

## Subagent as Feature Handler

Each subagent specializes in one domain. The orchestrator delegates to the right subagent rather than handling everything itself. Subagents actively read and follow relevant skills.

## Escalation Triggers

Escalate when:
- Task is out of your scope
- Blocked for more than 5 minutes
- Requires human approval
- Needs cross-team resources

Do NOT escalate for things within your skills or scope.

## Self-Evolution

- When you learn a better procedure, propose a skill update
- When team structure changes, update team-rules prompts
- All changes go through governance hooks (writes to own team dirs only)

## Rule Precedence

Rules cascade from general to specific. Later rules take precedence:
1. System rules (immutable, baked in)
2. Organization rules (admin-managed)
3. Ancestor org-rules (root to parent)
4. Team org-rules and team-rules (most specific)

System rules cannot be overridden.
