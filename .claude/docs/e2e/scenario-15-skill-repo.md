# Scenario 15: Skill Repository Search & Adoption

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

This scenario tests the `search_skill_repository` tool: availability, search and adoption flow with trust signals, and graceful degradation when skills.sh is unreachable.

#### Part A: Tool Availability

1. Verify `search_skill_repository` is listed in the agent's active tools:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"What tools do you have access to? List all of them.","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` mentions `search_skill_repository` in the tool list

2. VERIFY tool documented in sdk-capabilities.md:
   ```bash
   sudo docker exec openhive grep -c "search_skill_repository" /app/system-rules/sdk-capabilities.md
   ```
   - Should return >= 1 (tool is documented in system rules)

3. VERIFY tool is registered with audit wrapper (check container logs for tool registration):
   ```bash
   sudo docker logs openhive 2>&1 | grep -i "search_skill_repository\|skill.repo\|skill_repo" | tail -5
   ```
   - Should show the tool was registered during startup

#### Part B: Search & Adoption

4. Create a team that will receive the skill:
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a team called skill-test-eng for engineering tasks. Accept keywords: engineering, code, development.","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` confirms team created

5. Wait for bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/skill-test-eng/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

6. Ask the agent to search for and create a skill (triggers search_skill_repository):
   ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"Create a frontend code review skill for skill-test-eng. Search the skill repository first to see if there's something we can adapt.","timeout":300000}
   EOF
   ```

7. VERIFY tool was invoked (check audit logs):
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

8. VERIFY trust signals presented in agent response:
   ```bash
   curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":20}'
   ```
   - `.final` or progress frames should mention trust signals from search results:
     - Install count (e.g., "222K installs")
     - Source (e.g., "anthropics/skills", "vercel-labs")
     - Match score or relevance indicator
   - If matches were found (>= 60%), agent should have presented them before adopting
   - If no matches (< 60%), agent should have created from scratch (also acceptable)

9. VERIFY skill file was written (regardless of repo match or from-scratch creation):
   ```bash
   ls /app/openhive/.run/teams/skill-test-eng/skills/
   ```
   - Should contain a skill file (e.g., `code-review.md` or `frontend-review.md`)

   ```bash
   cat /app/openhive/.run/teams/skill-test-eng/skills/*.md 2>/dev/null | head -30
   ```
   - Skill should be in OpenHive format (Purpose, Steps, Inputs, Outputs, Error Handling sections)
   - Should NOT be raw Vercel SKILL.md format (no YAML frontmatter with bare name/description)

#### Part C: Graceful Degradation

10. Simulate skills.sh being unreachable by checking behavior when network fails.
    Ask the agent to create another skill (if skills.sh is unreachable, it should fall back):
    ```bash
    curl -s localhost:9876/send -d @- <<'EOF'
    {"name":"main","content":"Create a deployment checklist skill for skill-test-eng. This should cover pre-deploy checks, rollback procedures, and post-deploy verification.","timeout":300000}
    EOF
    ```

11. VERIFY the agent handled gracefully (regardless of skills.sh availability):
    ```bash
    curl -s localhost:9876/traffic -d '{"name":"main","direction":"recv","limit":20}'
    ```
    - `.final` should contain a confirmation that the skill was created
    - Should NOT contain error messages about skills.sh being down exposed to the user
    - The agent should either have adopted from repo or created from scratch

12. VERIFY no errors leaked to user in any case:
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

13. VERIFY skill file exists:
    ```bash
    ls /app/openhive/.run/teams/skill-test-eng/skills/
    ```
    - Should now contain at least 2 skill files (from steps 6 and 10)

14. Cleanup:
    ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"Shut down skill-test-eng.","timeout":300000}'
    ```

15. VERIFY health still 200:
    ```bash
    curl -sf http://localhost:8080/health | python3 -m json.tool
    ```

**Report:** search_skill_repository in tool list? Tool documented in sdk-capabilities.md? Audit logs show tool invocation with params and duration? Trust signals (installs, source, match score) presented to user? Skill file written in OpenHive format? Graceful degradation when skills.sh unreachable (no user-facing errors, fallback to from-scratch creation)?
