# Phase A: Deterministic Smoke Checks

Execute ALL of these via Bash. No AI calls needed. Report pass/fail for each.

```
SMOKE CHECKS:

Infrastructure:
 1. curl -sf http://localhost:8080/health -> returns 200 with "ok"
 2. Health JSON has storage, sessions, triggers, channels fields
 3. Docker inspect health status = "healthy"
 4. .run/teams/, .run/shared/, .run/backups/ directories exist in container
 5. Main team config.yaml has name=main, mcp_servers includes org
 6. Main team has all 5 subdirs: memory, org-rules, team-rules, skills, subagents
 7. /data/rules/escalation-policy.md exists and contains "escalation"
 8. /app/system-rules/ has .md files
 9. Container logs contain "OpenHive v3 started"

Database:
10. org_tree has "main" entry: SELECT name FROM org_tree WHERE name='main'
11. task_queue accessible: SELECT COUNT(*) FROM task_queue
12. task_queue has result column: SELECT result FROM task_queue LIMIT 0
13. 10 concurrent SELECT COUNT(*) FROM org_tree -- no errors

WebSocket:
14. Send {"content":"ping"} -> get response (connection works)
15. Send invalid JSON -> get error response, not crash
16. Send {"content":""} -> get error response
17. Health still 200 after error messages

Progressive WS Protocol:
18. Send a message and verify response has a 'type' field (ack, progress, or response)
19. Verify final message has type="response" with content field

System Rules:
20. sdk-capabilities.md inside container does NOT contain "denied by default" for Bash
    sudo docker exec openhive grep -c "denied by default" /app/system-rules/sdk-capabilities.md
    — should return 0

Report: N/20 smoke checks passed.

**STOP GATE:** If any smoke check fails, investigate container logs
(`sudo docker logs openhive 2>&1`) and report root causes
BEFORE proceeding to Phase B. Only proceed when all 20 pass or failures
are understood and documented.
```
