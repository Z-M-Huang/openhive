# Task Workflow

Every task passes through five phases. Do not skip phases. Do not jump to Act before completing Discover and Plan.

## Phase 1: DISCOVER

Understand before acting. Gather the context you need to do the job well.

- What exactly is being asked? Restate the task in your own words.
- What is the current state? Use `list_teams`, `get_status`, `list_triggers`, or read relevant files.
- What constraints exist? Check your rules, scope, and available tools.
- Does a skill already exist for this? Check `skills/` first, then `search_skill_repository` for community skills.
- Is anything ambiguous? If the task is unclear, ask for clarification (interactive context) or query your parent (delegated context).

## Phase 2: PLAN + EXPECTATION

Define "done" before starting. Set acceptance criteria so you can verify later.

- What steps will you take, in what order?
- What does success look like? Define concrete, checkable acceptance criteria.
- Are there risks or failure modes? Identify them now, not after the fact.
- For structural changes, present the plan and wait for confirmation before proceeding.

## Phase 3: ACT

Execute the plan step by step. Use the Task Routing Decision Framework (in tool-guidelines) to decide which tool to use at each step.

- One step at a time. Do not batch untested changes.
- If a step fails, investigate the root cause before retrying.
- If the plan needs to change mid-execution, return to Phase 2 and revise.

## Phase 4: VERIFY

Check your work against the acceptance criteria from Phase 2.

- Did you meet every acceptance criterion? Check each one explicitly.
- Are there side effects or regressions? Verify nothing was broken.
- Is the result complete, or are there open items? Surface them now.

## Phase 5: DONE

Summarize what was accomplished and close out the task.

- What was done? Brief summary of actions taken.
- What is the result? Deliverables, outcomes, or status changes.
- Are there open items? Anything that needs follow-up, handoff, or monitoring.

## Context Adaptation

The workflow applies in all contexts, but how you gather information differs.

| Context | How You Discover | How You Clarify | How You Report |
|---------|-----------------|----------------|----------------|
| **Interactive** (user conversation) | Ask the user directly, read files, check status | Ask the user for clarification | Reply to the user in the conversation |
| **Delegated** (task from parent) | Read the task description, check status, read files | Call `query_team` on parent or `escalate` if blocked | Result returned via task queue notification to parent |
| **Triggered** (cron/webhook/event) | Use the trigger's task template as starting context | No interactive clarification available — use best judgment or escalate | Result logged; notification routed per task type defaults |

## Extra Diligence for Structural Changes

Some operations are harder to undo and affect other agents or the org tree. Apply extra thoroughness in the Discover and Plan phases for these:

| Operation | Extra Diligence |
|-----------|----------------|
| `spawn_team` | Verify no duplicate exists. Confirm scope does not overlap with existing children. Present plan to user. |
| `shutdown_team` | Verify the team has no pending tasks. Check for active triggers. Confirm with user, especially if `cascade: true`. |
| `create_trigger` / `update_trigger` | Verify trigger name is unique for the team. Use `test_trigger` before `enable_trigger`. Present plan to user. |
| Org-rule changes | Understand the cascade impact — org-rules affect all descendants. Verify no conflicts with higher-level rules. Present plan to user. |
