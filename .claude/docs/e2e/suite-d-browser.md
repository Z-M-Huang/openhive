# Suite D: Browser (Scenarios 7, 8, 9, 10)

**Skip this entire suite if smoke checks 21-22 failed.**

Verification script: `node src/e2e/verify-suite-browser.cjs --step <step>`

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

## Part 1: Gating (from Scenario 7)

### 1A. Pre-flight & Browser-Enabled Team

**Step 1.** Verify `@playwright/mcp` exists in container:
```bash
sudo docker exec deployments-openhive-1 node -e "require('@playwright/mcp'); console.log('PLAYWRIGHT_MCP_OK')"
```
- PASS: prints `PLAYWRIGHT_MCP_OK`
- FAIL: module not found -- **STOP entire Suite D**

**Step 2.** Check startup logs for browser relay initialization:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser relay\|playwright" | tail -10
```
- Should show "Browser relay initialized" with tool count

**Step 3.** Send message to create web-team:
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"Create a team called web-team for web scraping tasks. Accept keywords: web, scraping, browser.","timeout":300000}'
```
- OBSERVE response, wait for bootstrap:
```bash
for i in $(seq 1 20); do
  node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\\"SELECT bootstrapped FROM org_tree WHERE name='web-team'\\").get();
    if (r && r.bootstrapped === 1) { console.log('BOOTSTRAPPED'); process.exit(0); }
    D.close();
    process.exit(1);
  " 2>/dev/null && break
  sleep 3
done
```

**Step 4.** Add `browser:` config and restart:
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

After restart, reconnect harness:
```bash
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

**Step 5.** Verify config on disk:
```bash
cat /app/openhive/.run/teams/web-team/config.yaml | grep -A5 "browser"
```

### 1B. Gate 1 -- MCP Registration (browser: config present/absent)

**Step 6.** Send message to check web-team tools:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask web-team to list all its available tools. Focus specifically on any browser-related tools.","timeout":300000}
EOF
```
- VERIFY: Response mentions `browser_navigate`, `browser_snapshot`, `browser_screenshot` or similar
- Check logs:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser.*tool\|relay.*web-team" | tail -5
```

**Step 7.** Create a team without browser config:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called no-browser-team for data analysis. Accept keywords: analysis, data.","timeout":300000}
EOF
```
- Wait for bootstrap, then verify no `browser:` in config:
```bash
for i in $(seq 1 20); do
  node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\\"SELECT bootstrapped FROM org_tree WHERE name='no-browser-team'\\").get();
    if (r && r.bootstrapped === 1) { console.log('BOOTSTRAPPED'); process.exit(0); }
    D.close();
    process.exit(1);
  " 2>/dev/null && break
  sleep 3
done
cat /app/openhive/.run/teams/no-browser-team/config.yaml
```

**Step 8.** Send message to check no-browser-team tools:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask no-browser-team to list all its available tools, especially any browser tools.","timeout":300000}
EOF
```
- VERIFY: Response does NOT mention browser_navigate or any browser_* tools
- This proves Gate 1: no `browser:` config = no browser tools registered

### 1C. Gate 2 -- allowed_tools Restriction

**Step 9.** Create restricted team with browser config but explicit allowed_tools that excludes browser:
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
  - delegate_task
  - escalate
  - get_credential
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
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db');
D.prepare(\"INSERT OR IGNORE INTO org_tree (name, parent_id, status) VALUES ('restricted-team', 'main', 'active')\").run();
D.close();
"
sudo docker restart deployments-openhive-1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

After restart, reconnect harness:
```bash
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

**Step 10.** Send message to test browser tool denied by allowed_tools:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask restricted-team to navigate to example.com using the browser.","timeout":300000}
EOF
```
- VERIFY: Response indicates browser tools are denied/unavailable
- Check logs for deny:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "denied\|canUseTool.*browser" | tail -5
```
- This proves Gate 2: `allowed_tools` doesn't include browser_* = calls denied

### 1D. Domain Allowlist

**Step 11.** Navigate to allowed domain:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask web-team to navigate to https://www.example.com and take an accessibility snapshot.","timeout":300000}
EOF
```
- VERIFY: Response contains content from example.com (page text visible in snapshot)

**Step 12.** Navigate to blocked domain:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask web-team to navigate to https://www.google.com and take an accessibility snapshot.","timeout":300000}
EOF
```
- VERIFY: Response indicates navigation blocked -- domain not in allowlist
- Check logs:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "domain\|allowlist\|blocked" | tail -5
```
- **PASS**: example.com allowed, google.com blocked
- **FAIL**: both work or both blocked

### 1E. Graceful Degradation

**Step 13.** Health check:
```bash
curl -sf http://localhost:8080/health | python3 -m json.tool
```

**Step 14.** Send normal message to verify server functional:
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"What teams do you have?","timeout":300000}'
```
- VERIFY: Normal response listing teams, health still 200

### Verify Part 1

```bash
node src/e2e/verify-suite-browser.cjs --step after-gating-setup
```

---

## Part 2: Operations (from Scenario 8)

### 2A. Setup Browser-Enabled Team

**Step 15.** Create browser-ops team:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called browser-ops for web operations. Accept keywords: web, browse, scrape.","timeout":300000}
EOF
```

**Step 16.** Wait for bootstrap, add unrestricted browser config, restart:
```bash
for i in $(seq 1 20); do
  node -e "
    const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    const r = D.prepare(\\"SELECT bootstrapped FROM org_tree WHERE name='browser-ops'\\").get();
    if (r && r.bootstrapped === 1) { console.log('BOOTSTRAPPED'); process.exit(0); }
    D.close();
    process.exit(1);
  " 2>/dev/null && break
  sleep 3
done
cat >> /app/openhive/.run/teams/browser-ops/config.yaml << 'YAML'
browser:
  timeout_ms: 30000
YAML
sudo docker restart deployments-openhive-1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

After restart, reconnect harness:
```bash
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

NOTE: No `allowed_domains` = all domains allowed. SSRF protection is a separate layer.

Verify config loaded:
```bash
cat /app/openhive/.run/teams/browser-ops/config.yaml | grep -A3 "browser"
```

### 2B. Navigation & Accessibility Snapshot

**Step 17.** Navigate and snapshot:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask browser-ops to navigate to https://example.com and take an accessibility snapshot. Report the page title and main heading text.","timeout":300000}
EOF
```
- VERIFY: Response contains "Example Domain"
- Check logs:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser_navigate\|browser_snapshot" | tail -5
```
- Check task completion:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
const r = D.prepare(\"SELECT status, substr(result,1,200) as r FROM task_queue WHERE team_id='browser-ops' ORDER BY created_at DESC LIMIT 1\").get();
console.log(JSON.stringify(r));
D.close();
"
```
- **PASS**: Response mentions "Example Domain", task completed
- **FAIL**: Task failed, no page content, or tools not found

### 2C. Screenshot

**Step 18.** Screenshot test:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask browser-ops to navigate to https://example.com and take a screenshot. Describe what the screenshot shows.","timeout":300000}
EOF
```
- VERIFY: Response describes visual appearance of example.com
- Check logs:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser_screenshot" | tail -5
```
- NOTE: `browser_screenshot` returns ImageContent. Agent describes image via multimodal vision. The relay must correctly pass ImageContent through without wrapping in JSON.
- **PASS**: Agent describes page visuals, screenshot tool in logs
- **FAIL**: Error about ImageContent, tool not found, or generic error

### 2D. SSRF Protection

**Step 19.** Test SSRF protection against 3 private IP ranges:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask browser-ops to try navigating to these three URLs one by one and report what happens for each: (1) http://169.254.169.254/latest/meta-data/ (2) http://127.0.0.1:8080/health (3) http://10.0.0.1/ — Report whether each navigation was blocked or succeeded.","timeout":300000}
EOF
```
- VERIFY: ALL THREE blocked
- Check logs:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -iE "blocked|ssrf|private|validateUrl" | tail -10
```
- **PASS**: All private IPs blocked at Layer 1 (validateUrl) or Layer 2 (--blocked-origins)
- **FAIL**: Any private IP navigation succeeds and returns content

**Step 20.** Health check after SSRF attempts:
```bash
curl -sf http://localhost:8080/health
```

### Verify Part 2

```bash
node src/e2e/verify-suite-browser.cjs --step after-browser-ops
```

---

## Part 3: Isolation (from Scenario 9)

### 3A. Setup Two Browser-Enabled Teams

**Step 21.** Create scraper-alpha:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called scraper-alpha for scraping site A. Accept keywords: scraping, alpha.","timeout":300000}
EOF
```

**Step 22.** Create scraper-beta:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Create a team called scraper-beta for scraping site B. Accept keywords: scraping, beta.","timeout":300000}
EOF
```

**Step 23.** Wait for both bootstraps, add browser configs with different domain allowlists, restart:
```bash
for team in scraper-alpha scraper-beta; do
  for i in $(seq 1 20); do
    node -e "
      const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
      const r = D.prepare(\\"SELECT bootstrapped FROM org_tree WHERE name='$team'\\").get();
      if (r && r.bootstrapped === 1) { console.log('$team BOOTSTRAPPED'); process.exit(0); }
      D.close();
      process.exit(1);
    " 2>/dev/null && break
    sleep 3
  done
done

cat >> /app/openhive/.run/teams/scraper-alpha/config.yaml << 'YAML'
browser:
  allowed_domains:
    - "*.example.com"
    - "example.com"
  timeout_ms: 30000
YAML

cat >> /app/openhive/.run/teams/scraper-beta/config.yaml << 'YAML'
browser:
  allowed_domains:
    - "*.example.org"
    - "example.org"
  timeout_ms: 30000
YAML

sudo docker restart deployments-openhive-1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

After restart, reconnect harness:
```bash
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

**Step 24.** Verify two separate relay processes in logs:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser relay\|playwright.*start" | tail -10
```

### 3B. Domain Isolation Between Teams

**Step 25.** Navigate alpha to allowed domain:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask scraper-alpha to navigate to https://example.com and report the page title.","timeout":300000}
EOF
```
- VERIFY: Response mentions "Example Domain" (allowed by alpha's allowlist)

**Step 26.** Navigate beta to alpha's domain (should be blocked):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask scraper-beta to navigate to https://example.com and report the page title.","timeout":300000}
EOF
```
- VERIFY: Navigation BLOCKED (example.com not in beta's `*.example.org` allowlist)
- This proves cross-team domain isolation: alpha's allowed domains don't leak to beta

**Step 27.** Verify process isolation inside container:
```bash
sudo docker exec deployments-openhive-1 ps aux | grep -i "playwright\|chromium" | grep -v grep
```
- Should show separate processes for each team (different PIDs)

### 3C. Task Delegation with Browser + File Write

**Step 28.** Combined browser + file write delegation:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask scraper-alpha to navigate to example.com, take an accessibility snapshot, and write a summary of the page to its skills/web-summary.md file.","timeout":300000}
EOF
```
- Verify task completed, check host filesystem:
```bash
cat /app/openhive/.run/teams/scraper-alpha/skills/web-summary.md
```
- File should exist and contain content about example.com
- Proves browser + file write work together in a delegated task

### 3D. Main Team Without Browser

**Step 29.** Send browser request to main (no browser config):
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Navigate to example.com and tell me what the page says.","timeout":300000}
EOF
```
- VERIFY: Main team either routes to a browser-enabled child or reports it has no browser tools
- Server must NOT crash:
```bash
curl -sf http://localhost:8080/health
```

### Verify Part 3

```bash
node src/e2e/verify-suite-browser.cjs --step after-isolation
```

---

## Part 4: Lifecycle (from Scenario 10)

**NO clean restart -- continues from Part 3.**

### 4A. Idle TTL Cleanup

**Step 30.** Record browser processes before idle wait:
```bash
sudo docker exec deployments-openhive-1 ps aux | grep -i "playwright\|chromium" | grep -v grep | wc -l
echo "Browser processes BEFORE idle wait"
```

**Step 31.** Poll for idle TTL cleanup (check every 30s, max 7 min):
```bash
echo "Polling for idle TTL cleanup (max 420s)..."
for i in $(seq 1 14); do
  COUNT=$(sudo docker exec deployments-openhive-1 ps aux | grep -i "playwright\|chromium" | grep -v grep | wc -l)
  echo "  Check $i: $COUNT browser processes"
  if [ "$COUNT" -eq 0 ]; then echo "CLEANUP_DETECTED after $((i*30))s"; break; fi
  sleep 30
done
```

**Step 32.** Verify browser processes cleaned up:
```bash
AFTER=$(sudo docker exec deployments-openhive-1 ps aux | grep -i "playwright\|chromium" | grep -v grep | wc -l)
echo "Browser processes AFTER idle wait: $AFTER"
```
- Count should be 0 (or fewer than step 30)
- If still running after 7 min: INVESTIGATE -- check TTL config, relay cleanup logic
- Check logs for cleanup:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "idle\|cleanup\|ttl" | tail -10
```

**Step 33.** Health still OK:
```bash
curl -sf http://localhost:8080/health
```

**Step 34.** On-demand re-spawn -- send a browser request after cleanup:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask scraper-alpha to navigate to https://example.com and report the title.","timeout":300000}
EOF
```
- VERIFY: Task completes successfully (relay re-spawned on demand)
- Check logs for relay restart:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser relay.*start\|spawn.*playwright" | tail -5
```
- **PASS**: Idle cleanup happened (count decreased), then browser restarted on demand
- **FAIL**: Processes never cleaned up, or browser fails to restart after cleanup

### 4B. Restart Persistence

**Step 35.** Restart container:
```bash
sudo docker restart deployments-openhive-1
for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
```

After restart, reconnect harness:
```bash
curl -s localhost:9876/reconnect -d '{"name":"main"}'
```

**Step 36.** Verify team configs survived restart:
```bash
cat /app/openhive/.run/teams/scraper-alpha/config.yaml | grep -A5 "browser"
cat /app/openhive/.run/teams/scraper-beta/config.yaml | grep -A5 "browser"
```
- Both should still have `browser:` sections intact

**Step 37.** Verify org tree survived:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
console.log(JSON.stringify(D.prepare('SELECT name FROM org_tree').all()));
D.close();
"
```
- Should list scraper-alpha and scraper-beta

**Step 38.** Verify browser relay re-discovery on startup:
```bash
sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser\|relay\|playwright" | tail -10
```
- Logs should show browser relay available (lazy-start on first request is acceptable)

**Step 39.** Post-restart browser test:
```bash
curl -s localhost:9876/send -d @- <<'EOF'
{"name":"main","content":"Ask scraper-alpha to navigate to https://example.com and report the page title.","timeout":300000}
EOF
```
- VERIFY: Response mentions "Example Domain" (browser tools work after restart)

**Step 40.** Final health check:
```bash
curl -sf http://localhost:8080/health | python3 -m json.tool
```

### 4C. Cleanup

**Step 41.** Shut down browser teams:
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"Shut down scraper-alpha","timeout":300000}'
```

**Step 42.**
```bash
curl -s localhost:9876/send -d '{"name":"main","content":"Shut down scraper-beta","timeout":300000}'
```

**Step 43.** Verify both removed from org_tree:
```bash
node -e "
const D = require('/app/openhive/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
console.log(JSON.stringify(D.prepare('SELECT name FROM org_tree').all()));
D.close();
"
```
- Neither scraper-alpha nor scraper-beta should appear

**Step 44.** Health still OK:
```bash
curl -sf http://localhost:8080/health
```

### Verify Part 4

```bash
node src/e2e/verify-suite-browser.cjs --step after-lifecycle
```

---

## Report Checklist

- Pre-flight passed (@playwright/mcp installed, relay initialized)?
- Gate 1 (MCP registration): browser tools present only when browser: config exists?
- Gate 2 (allowed_tools): browser tools denied when not in allowed_tools?
- Domain allowlist: allowed domains pass, blocked domains rejected?
- Graceful degradation: server stable regardless of browser relay status?
- Navigation works (example.com content returned)?
- Snapshot returns page content?
- Screenshot returns ImageContent correctly?
- All 3 SSRF vectors blocked (metadata endpoint, localhost, RFC1918)?
- Health stable after SSRF attempts?
- Two relay processes started for two browser teams?
- Domain isolation works (alpha=example.com OK, beta=example.com blocked)?
- Process isolation verified (separate PIDs)?
- Delegation + browser + file write work together?
- Main team handles missing browser gracefully?
- Idle TTL cleanup worked (process count decreased)?
- Browser re-activates on demand after cleanup?
- Config survived restart?
- Org tree survived restart?
- Browser tools functional after restart?
- Teams cleaned up properly?
