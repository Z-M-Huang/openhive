# Scenario 8: Browser Navigation, Snapshot, Screenshot & SSRF Protection

**Run the Clean Restart Helper from setup.md.**

#### Part A: Setup Browser-Enabled Team

1. Send: "Create a team called browser-ops for web operations. Accept keywords: web, browse, scrape."

2. Wait for bootstrap, then add unrestricted browser config:
   ```bash
   for i in $(seq 1 20); do
     test -f /app/openhive/.run/teams/browser-ops/memory/.bootstrapped && echo "BOOTSTRAPPED" && break
     sleep 3
   done
   cat >> /app/openhive/.run/teams/browser-ops/config.yaml << 'YAML'
   browser:
     timeout_ms: 30000
   YAML
   sudo docker restart deployments-openhive-1
   for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
   ```
   NOTE: No `allowed_domains` → all domains allowed. SSRF protection is a separate layer.

   VERIFY config loaded:
   ```bash
   cat /app/openhive/.run/teams/browser-ops/config.yaml | grep -A3 "browser"
   ```

#### Part B: Navigation & Accessibility Snapshot

3. Send: "Ask browser-ops to navigate to https://example.com and take an accessibility snapshot. Report the page title and main heading text."
   - VERIFY: Response contains "Example Domain"
   - VERIFY logs show browser tool calls:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser_navigate\|browser_snapshot" | tail -5
   ```
   - VERIFY task completion in DB:
   ```bash
   node -e "
   const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   const r = D.prepare(\"SELECT status, substr(result,1,200) as r FROM task_queue WHERE team_id='browser-ops' ORDER BY created_at DESC LIMIT 1\").get();
   console.log(JSON.stringify(r));
   D.close();
   "
   ```

   **PASS**: Response mentions "Example Domain", task completed
   **FAIL**: Task failed, no page content, or tools not found

#### Part C: Screenshot

4. Send: "Ask browser-ops to navigate to https://example.com and take a screenshot. Describe what the screenshot shows."
   - VERIFY: Response describes visual appearance of example.com
   - VERIFY: browser_screenshot tool call in logs:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser_screenshot" | tail -5
   ```
   - NOTE: `browser_screenshot` returns ImageContent. Agent describes image via multimodal vision. The relay must correctly pass ImageContent through without wrapping in JSON.

   **PASS**: Agent describes page visuals, screenshot tool in logs
   **FAIL**: Error about ImageContent, tool not found, or generic error

#### Part D: SSRF Protection

5. Send: "Ask browser-ops to try navigating to these three URLs one by one and report what happens for each: (1) http://169.254.169.254/latest/meta-data/ (2) http://127.0.0.1:8080/health (3) http://10.0.0.1/ — Report whether each navigation was blocked or succeeded."
   - VERIFY: ALL THREE blocked
   - VERIFY logs show SSRF rejection:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -iE "blocked|ssrf|private|validateUrl" | tail -10
   ```

   **PASS**: All private IPs blocked at Layer 1 (validateUrl) or Layer 2 (--blocked-origins)
   **FAIL**: Any private IP navigation succeeds and returns content

6. Verify health after SSRF attempts:
   ```bash
   curl -sf http://localhost:8080/health
   ```

**Report:** Navigation works? Snapshot returns page content? Screenshot returns ImageContent correctly? All 3 SSRF vectors blocked (metadata endpoint, localhost, RFC1918)? Health stable after SSRF attempts?
