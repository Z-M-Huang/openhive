---
name: task-completion
description: "How to finalize tasks, report results, and handle cleanup when work is done"
allowed-tools:
  - update_task_status
  - send_message
  - save_memory
  - get_task
---

## When to Apply

Use this skill when you have finished working on a task -- whether successfully completed, failed after exhausting approaches, or cancelled by a supervisor. Every task must be explicitly finalized; never silently stop working without reporting status.

## Steps

### 1. Verify Completion

Before reporting a task as complete, verify your work against the original requirements:

- Use `get_task` to re-read the original task prompt and any parameters.
- Check that all requested deliverables exist and are in the expected location.
- If the task had specific acceptance criteria, verify each one.
- If the task produced files, confirm they are written to the correct path under `/app/workspace/work/tasks/`.

### 2. Prepare the Result

Compose a clear, structured result that your team lead or the requesting agent can act on:

**For successful completion:**
- Summarize what was accomplished in 2-3 sentences.
- List all deliverables with their file paths.
- Note any assumptions made or decisions taken during execution.
- Flag any follow-up actions that may be needed.

**For failed tasks:**
- Explain the root cause of failure specifically.
- List all approaches attempted and why each failed.
- Suggest alternative approaches or resources that might succeed.
- Include any partial results that may be salvageable.

**For cancelled tasks:**
- Acknowledge the cancellation.
- Report any partial work completed before cancellation.
- Note any cleanup performed or still needed.

### 3. Update Task Status

Use `update_task_status` with the appropriate status and result:

```
update_task_status:
  task_id: <your-task-id>
  status: "completed" | "failed" | "cancelled"
  result: <structured result from step 2>  # for completed tasks
  error: <error details>                    # for failed tasks
```

Status meanings:
- **completed**: Task finished successfully. All deliverables produced.
- **failed**: Task could not be completed after reasonable effort. Includes error context.
- **cancelled**: Task was cancelled by a supervisor via escalation response or direct instruction.

### 4. Notify Relevant Parties

If the task was a subtask, your team lead receives the status update automatically through the task system. However, in these cases, also send an explicit message:

- The task result requires immediate attention or action.
- The task failed and the failure may impact other in-progress tasks.
- The task produced results that unblock other agents' work.

```
send_message:
  target_aid: <team-lead-aid or requesting-agent-aid>
  content: <brief summary of task outcome>
```

### 5. Save Learnings

After completing a task, save relevant learnings to your memory:

- Use `save_memory` with `memory_type: "daily"` for task-specific observations.
- If you discovered a pattern that will be useful across future tasks, note it for later curation.

What to record:
- Approaches that worked well (or did not).
- Unexpected behaviors or edge cases encountered.
- Time-consuming steps that could be optimized.
- Domain knowledge gained during execution.

### 6. Clean Up

After reporting results:

- Do not delete working files -- they may be needed for review or audit.
- Ensure all temporary files are in the task-specific directory (`/app/workspace/work/tasks/<task-id>/`), not scattered in the workspace root.
- Close any resources you opened (connections, file handles).
- If you created subtasks that are still pending, note them in your result so your lead can decide whether to cancel or reassign them.

## Result Quality Checklist

Before calling `update_task_status`, verify:

- [ ] Result directly addresses the original task prompt
- [ ] All deliverable file paths are absolute and correct
- [ ] No sensitive information (credentials, keys) in the result text
- [ ] Assumptions and decisions are documented
- [ ] For failures: root cause and attempted approaches are included
- [ ] For partial completion: clear boundary between done and remaining work

## Examples

### Successful Completion

```
update_task_status:
  task_id: "task-abc-123"
  status: "completed"
  result: "Generated quarterly sales report covering Q4 2025.
    Deliverables:
    - /app/workspace/work/tasks/task-abc-123/report.pdf
    - /app/workspace/work/tasks/task-abc-123/data.csv
    Key findings: Revenue up 12% QoQ, driven by enterprise segment.
    Note: Marketing spend data was estimated for December (actual
    figures not yet available in the data source)."
```

### Failed Task

```
update_task_status:
  task_id: "task-def-456"
  status: "failed"
  error: "Unable to connect to the external analytics API after 3
    retry cycles (attempts at 0s, 30s, 120s). Server returns 503.
    Checked status page -- service is in scheduled maintenance
    until 2026-03-12 06:00 UTC. Suggest retrying after maintenance
    window. Partial data collected before outage saved at:
    /app/workspace/work/tasks/task-def-456/partial-export.json"
```
