---
name: escalation
description: "When and how to escalate tasks up the chain of command when blocked, out of scope, or beyond capability"
allowed-tools:
  - escalate
  - send_message
  - get_task
---

## When to Apply

Use this skill when you encounter any of the following situations during task execution:

- **Blocked:** You cannot proceed because a dependency is unresolved, a resource is unavailable, or you lack the required permissions.
- **Out of scope:** The task requires capabilities, tools, or domain knowledge that fall outside your assigned role or skill set.
- **Repeated failure:** You have attempted the task multiple times (3+ attempts) with different approaches and continue to fail.
- **Ambiguous requirements:** The task prompt is unclear or contradictory, and you cannot resolve the ambiguity from available context or memory.
- **Safety concern:** The task involves a potentially destructive or irreversible action that you are not authorized to perform autonomously.
- **Resource limits:** You are approaching your configured `max_turns` or `timeout_minutes` limit without completing the task.

Do NOT escalate when:

- You have not yet attempted the task. Try first, escalate second.
- The issue is a transient error (network timeout, temporary file lock). Retry with backoff before escalating.
- You can resolve the issue by consulting your loaded skills or memory. Check `recall_memory` first.

## Steps

1. **Assess the situation.** Before escalating, clearly identify:
   - What you were trying to accomplish.
   - What specific obstacle prevents progress.
   - What approaches you already attempted.
   - Why you believe escalation is the appropriate next step.

2. **Gather context.** Collect relevant information for the escalation:
   - Use `get_task` to retrieve the current task details, including the original prompt, priority, and any parent task chain.
   - Note any partial results or progress made so far.
   - Identify the specific type of help needed (authorization, expertise, resource, clarification).

3. **Compose the escalation.** Use the `escalate` tool with:
   - `task_id`: The ID of the task you are escalating.
   - `reason`: A concise explanation of why you are escalating. Be specific -- "I'm stuck" is not sufficient. Example: "Task requires database schema migration permissions that are not in my allowed tools."
   - `context`: Include partial results, attempted approaches, and any relevant error messages.

4. **Pause and wait.** After escalating, your current task is paused. Do not continue working on it. The escalation routes up your chain of command -- to your team lead, and potentially further up if they cannot resolve it either.

5. **Resume when unblocked.** When you receive a response to your escalation (via `send_message` or a new task assignment), resume work incorporating the guidance or resources provided.

## Escalation Chain

Escalations follow the team hierarchy:

```
Member Agent --> Team Lead --> Parent Team Lead --> Main Assistant --> User
```

Each level in the chain can either:
- **Resolve** the escalation by providing the needed resource, permission, or guidance.
- **Re-escalate** up to the next level if the issue is beyond their scope.

The chain terminates at the user, who always has final authority.

## Escalation Quality Checklist

Before calling `escalate`, verify your escalation includes:

- [ ] Specific description of the blocker (not vague or generic)
- [ ] List of approaches already attempted
- [ ] Partial results or progress, if any
- [ ] What specific help is needed (permission, expertise, resource, clarification)
- [ ] Impact assessment (how blocking is this? can other work continue?)

## Examples

### Good Escalation

```
reason: "Cannot complete database migration task. The migrate_schema tool
is not in my allowed tools list. I attempted to use file operations to
write the migration SQL directly, but the database connection requires
credentials I do not have access to via get_credential."

context: "Partial progress: migration SQL drafted at
/app/workspace/work/tasks/task-123/migration.sql. Needs review and
execution by an agent with database admin tools."
```

### Poor Escalation (Avoid)

```
reason: "I can't do this task."
context: ""
```
