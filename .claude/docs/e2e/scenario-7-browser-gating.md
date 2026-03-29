# Scenario 7: Browser Tool Gating, Domain Allowlist & Graceful Degradation

**Run the Clean Restart Helper from setup.md.**

#### Part A: Pre-flight & Browser-Enabled Team

1. Verify `@playwright/mcp` exists in container:
   ```bash
   sudo docker exec deployments-openhive-1 node -e "require('@playwright/mcp'); console.log('PLAYWRIGHT_MCP_OK')"
   ```
   - PASS: prints `PLAYWRIGHT_MCP_OK`
   - FAIL: module not found → **STOP all browser scenarios (7-10)**

2. Check startup logs for browser relay initialization:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser relay\|playwright" | tail -10
   ```
   - Should show "Browser relay initialized" with tool count

3. Send: "Create a team called web-team for web scraping tasks. Accept keywords: web, scraping, browser."
   - OBSERVE response, wait for bootstrap:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/web-team/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   ```

4. Add `browser:` config and restart:
   ```bash
   cat >> /app/openhive/.run/teams/web-team/config.yaml << 'YAML'
   browser:
     allowed_domains:
       - "*.example.com"
       - "example.com"
     timeout_ms: 30000
   YAML
   sudo docker restart deployments-openhive-1
   for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
   ```

5. VERIFY config on disk:
   ```bash
   cat /app/openhive/.run/teams/web-team/config.yaml | grep -A5 "browser"
   ```

#### Part B: Gate 1 — MCP Registration (browser: config present/absent)

6. Send: "Ask web-team to list all its available tools. Focus specifically on any browser-related tools."
   - VERIFY: Response mentions `browser_navigate`, `browser_snapshot`, `browser_screenshot` or similar
   - VERIFY logs:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser.*tool\|relay.*web-team" | tail -5
   ```

7. Send: "Create a team called no-browser-team for data analysis. Accept keywords: analysis, data."
   - Wait for bootstrap. VERIFY no `browser:` in config:
   ```bash
   cat /app/openhive/.run/teams/no-browser-team/config.yaml
   ```

8. Send: "Ask no-browser-team to list all its available tools, especially any browser tools."
   - VERIFY: Response does NOT mention browser_navigate or any browser_* tools
   - This proves Gate 1: no `browser:` config → no browser tools registered

#### Part C: Gate 2 — allowed_tools Restriction

9. Create restricted team with browser config but explicit allowed_tools that excludes browser:
   ```bash
   mkdir -p /app/openhive/.run/teams/restricted-team/{memory,org-rules,team-rules,skills,subagents}
   cat > /app/openhive/.run/teams/restricted-team/config.yaml << 'YAML'
   name: restricted-team
   description: Team with browser config but restricted tool access
   parent: main
   allowed_tools:
     - Read
     - Write
     - Bash
     - mcp__org__delegate_task
     - mcp__org__escalate
     - mcp__org__get_credential
   mcp_servers:
     - org
   provider_profile: default
   maxTurns: 50
   browser:
     allowed_domains:
       - "*.example.com"
     timeout_ms: 30000
   YAML
   ```
   Register in org_tree and restart:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db');
   D.prepare(\"INSERT OR IGNORE INTO org_tree (name, parent_id, status) VALUES ('restricted-team', 'main', 'active')\").run();
   D.close();
   "
   sudo docker restart deployments-openhive-1
   for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
   ```

10. Send: "Ask restricted-team to navigate to example.com using the browser."
    - VERIFY: Response indicates browser tools are denied/unavailable
    - Check logs for canUseTool deny:
    ```bash
    sudo docker logs deployments-openhive-1 2>&1 | grep -i "denied\|canUseTool.*browser" | tail -5
    ```
    - This proves Gate 2: `allowed_tools` doesn't include browser_* → calls denied

#### Part D: Domain Allowlist

11. Send: "Ask web-team to navigate to https://www.example.com and take an accessibility snapshot."
    - VERIFY: Response contains content from example.com (page text visible in snapshot)

12. Send: "Ask web-team to navigate to https://www.google.com and take an accessibility snapshot."
    - VERIFY: Response indicates navigation blocked — domain not in allowlist
    - Check logs for domain validation message:
    ```bash
    sudo docker logs deployments-openhive-1 2>&1 | grep -i "domain\|allowlist\|blocked" | tail -5
    ```

    **PASS**: example.com allowed, google.com blocked
    **FAIL**: both work or both blocked

#### Part E: Graceful Degradation

13. Verify server health is stable regardless of browser relay status:
    ```bash
    curl -sf http://localhost:8080/health | python3 -m json.tool
    ```

14. Send: "What teams do you have?"
    - VERIFY: Normal response listing teams (server functional)
    - Health still 200

**Report:** Pre-flight passed? Gate 1 (MCP registration) works? Gate 2 (allowed_tools) works? Domain allowlist blocks unauthorized domains? Graceful degradation works? Health stable?
