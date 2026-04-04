# Phase A: Deterministic Smoke Checks

Execute ALL of these via Bash. No AI calls needed. Report pass/fail for each.

```
SMOKE CHECKS:

Infrastructure:
 1. curl -sf http://localhost:8080/health -> returns 200 with "ok"
 2. Health JSON has storage, sessions, triggers, channels fields
 3. Docker inspect health status = "healthy"
 4. .run/teams/, .run/shared/, .run/backups/ directories exist in container
 5. Main team config.yaml has name=main, mcp_servers is [] (empty)
 6. Main team has all 4 subdirs: org-rules, team-rules, skills, subagents
 7. /data/rules/escalation-policy.md exists and contains "escalation"
 8. /app/system-rules/ has .md files
 9. Container logs contain "OpenHive v4 started"

Database:
10. org_tree has "main" entry: SELECT name FROM org_tree WHERE name='main'
11. task_queue accessible: SELECT COUNT(*) FROM task_queue
12. task_queue has result column: SELECT result FROM task_queue LIMIT 0
13. 10 concurrent SELECT COUNT(*) FROM org_tree -- no errors

WebSocket (via harness):
14. curl -s localhost:9876/send -d '{"name":"main","content":"ping","timeout":30000}'
    -> .ok is true, .final contains a response
15. curl -s localhost:9876/send_raw -d '{"name":"main","payload":"not json","timeout":10000}'
    -> response contains type "error", server did not crash
16. curl -s localhost:9876/send_raw -d '{"name":"main","payload":"{\"content\":\"\"}","timeout":10000}'
    -> response contains type "error"
17. Health still 200 after error messages

Progressive WS Protocol (via harness):
18. Send a message and verify .exchange[0] has a 'type' field (ack, progress, or response)
    curl -s localhost:9876/send -d '{"name":"main","content":"Hello","timeout":60000}'
    -> .exchange array entries have type field
19. Verify terminal frame has type="response" with content field
    -> .exchange last entry has type "response"

System Rules:
20. sdk-capabilities.md inside container does NOT contain "denied by default" for Bash
    sudo docker exec openhive grep -c "denied by default" /app/system-rules/sdk-capabilities.md
    — should return 0

Browser Relay:
21. Container has @playwright/mcp installed:
    sudo docker exec deployments-openhive-1 node -e "require('@playwright/mcp'); console.log('OK')"
    — should print OK (if not, browser scenarios 7-10 will be skipped)
22. Startup logs contain browser relay status:
    sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser relay\|playwright"
    — should show "Browser relay initialized" with tool count
    — OR "browser tools disabled" (graceful degradation — acceptable, browser scenarios skipped)

Enhanced (absorbed from scenarios 1+6 — core platform + protocol):
23. Verify WS frame ordering using /traffic endpoint:
    curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":20}'
    → frames have ascending seq numbers; if both ack and response present, ack.seq < response.seq
24. Ask about skills:
    curl -s localhost:9876/send -d '{"name":"main","content":"What skills did you load?","timeout":60000}'
    → response mentions available skills (greeting, sig, or similar)
25. Run verification script for enhanced checks:
    node src/e2e/verify-smoke.cjs --step enhanced
    → all checks pass (skills dir has .md files, team-rules/org-rules dirs exist, memories seeded in SQLite)

Report: N/25 smoke checks passed.

**STOP GATE:** If any smoke check fails, investigate container logs
(`sudo docker logs openhive 2>&1`) and report root causes
BEFORE proceeding to Phase B. Only proceed when all 25 pass or failures
are understood and documented. If checks 21-22 fail, skip Suite D
(browser) but continue with other suites.
```
