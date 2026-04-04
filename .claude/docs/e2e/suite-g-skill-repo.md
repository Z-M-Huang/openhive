# Suite G: Skill Repository (Scenario 15)

Verification script: `node src/e2e/verify-suite-skill-repo.cjs --step <step>`

---

## Clean Restart

```bash
cd /app/openhive
sudo docker compose -f deployments/docker-compose.yml down -v 2>&1 || true
sudo rm -rf .run && mkdir -p .run
rm -f data/rules/*.md
cp seed-rules/* data/rules/ 2>/dev/null || true
sudo docker compose -f deployments/docker-compose.yml up -d 2>&1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

Reset harness and reconnect:
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

---

## Part 1: Tool Availability

**Step 1.** Verify `search_skill_repository` is listed in the agent's active tools:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"What tools do you have access to? List all of them.","timeout":300000}
EOF
```
- VERIFY: `.final` mentions `search_skill_repository` in the tool list

**Step 2.** Verify tool documented in sdk-capabilities.md:
```bash
sudo docker exec openhive grep -c "search_skill_repository" /app/system-rules/sdk-capabilities.md
```
- Should return >= 1 (tool is documented in system rules)

**Step 3.** Verify tool is registered with audit wrapper (check container logs for tool registration):
```bash
sudo docker logs openhive 2>&1 | grep -i "search_skill_repository\|skill.repo\|skill_repo" | tail -5
```
- Should show the tool was registered during startup

### Verify Part 1

```bash
node src/e2e/verify-suite-skill-repo.cjs --step after-tool-check
```

---

## Part 2: Search & Adoption

**Step 4.** Create a team that will receive the skill:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called skill-test-eng for engineering tasks. Accept keywords: engineering, code, development.","timeout":300000}
EOF
```
- VERIFY: `.final` confirms team created

**Step 5.** Wait for bootstrap:
```bash
for i in $(seq 1 20); do
  test -f /app/openhive/.run/teams/skill-test-eng/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
  sleep 3
done
```

**Step 6.** Ask the agent to search for and create a skill (triggers search_skill_repository):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a frontend code review skill for skill-test-eng. Search the skill repository first to see if there's something we can adapt.","timeout":300000}
EOF
```

**Step 7.** Verify tool was invoked (check audit logs):
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const rows = D.prepare(\"SELECT message, context FROM log_entries WHERE message IN ('PreToolUse','PostToolUse') AND context LIKE '%search_skill_repository%' ORDER BY created_at DESC LIMIT 5\").all();
for (const r of rows) {
  const ctx = JSON.parse(r.context || '{}');
  console.log(JSON.stringify({ msg: r.message, tool: ctx.tool, hasParams: !!ctx.params, hasDuration: !!ctx.durationMs }));
}
D.close();
"
```
- PreToolUse should have `tool: "search_skill_repository"` with `params` containing a query
- PostToolUse should have `tool: "search_skill_repository"` with `durationMs`

**Step 8.** Verify trust signals presented in agent response:
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":20}'
```
- `.final` or progress frames should mention trust signals from search results:
  - Install count (e.g., "222K installs")
  - Source (e.g., "anthropics/skills", "vercel-labs")
  - Match score or relevance indicator
- If matches were found (>= 60%), agent should have presented them before adopting
- If no matches (< 60%), agent should have created from scratch (also acceptable)

**Step 9.** Verify skill file was written (regardless of repo match or from-scratch creation):
```bash
ls /app/openhive/.run/teams/skill-test-eng/skills/
```
- Should contain a skill file (e.g., `code-review.md` or `frontend-review.md`)

```bash
cat /app/openhive/.run/teams/skill-test-eng/skills/*.md 2>/dev/null | head -30
```
- Skill should be in OpenHive format (Purpose, Steps, Inputs, Outputs, Error Handling sections)
- Should NOT be raw Vercel SKILL.md format (no YAML frontmatter with bare name/description)

### Verify Part 2

```bash
node src/e2e/verify-suite-skill-repo.cjs --step after-skill-create
```

---

## Part 3: Graceful Degradation

**Step 10.** Simulate skills.sh being unreachable by checking behavior when network fails. Ask the agent to create another skill (if skills.sh is unreachable, it should fall back):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a deployment checklist skill for skill-test-eng. This should cover pre-deploy checks, rollback procedures, and post-deploy verification.","timeout":300000}
EOF
```

**Step 11.** Verify the agent handled gracefully (regardless of skills.sh availability):
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":20}'
```
- `.final` should contain a confirmation that the skill was created
- Should NOT contain error messages about skills.sh being down exposed to the user
- The agent should either have adopted from repo or created from scratch

**Step 12.** Verify no errors leaked to user in any case:
```bash
curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":30}'
```
- No frame should have `type: "error"` related to skill repository
- If skills.sh was unreachable, check container logs for the warning:
```bash
sudo docker logs openhive 2>&1 | grep -i "skill.*unreachable\|skill.*error\|skill.*timeout\|skill.*fallback" | tail -5
```
- Warning log is acceptable (expected graceful degradation)
- Error that crashed or blocked the request is NOT acceptable

**Step 13.** Verify skill file exists:
```bash
ls /app/openhive/.run/teams/skill-test-eng/skills/
```
- Should now contain at least 2 skill files (from steps 6 and 10)

---

## Part 4: Cleanup

**Step 14.** Shut down the team:
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"Shut down skill-test-eng.","timeout":300000}'
```

**Step 15.** Health check:
```bash
curl -sf http://localhost:8080/health | python3 -m json.tool
```

### Verify Part 4

```bash
node src/e2e/verify-suite-skill-repo.cjs --step after-cleanup
```

---

## Report Checklist

- search_skill_repository in tool list?
- Tool documented in sdk-capabilities.md?
- Audit logs show tool invocation with params and duration?
- Trust signals (installs, source, match score) presented to user?
- Skill file written in OpenHive format (not raw Vercel SKILL.md)?
- Graceful degradation when skills.sh unreachable (no user-facing errors, fallback to from-scratch creation)?
- At least 2 skill files created?
- Team cleaned up properly?
- Health stable throughout?
