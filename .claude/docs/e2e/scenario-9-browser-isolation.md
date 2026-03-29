# Scenario 9: Browser Isolation & Task Delegation

**Run the Clean Restart Helper from setup.md.**

#### Part A: Setup Two Browser-Enabled Teams

1. Send: "Create a team called scraper-alpha for scraping site A. Accept keywords: scraping, alpha."

2. Send: "Create a team called scraper-beta for scraping site B. Accept keywords: scraping, beta."

3. Wait for both bootstraps, then add browser configs with different domain allowlists:
   ```bash
   for team in scraper-alpha scraper-beta; do
     for i in $(seq 1 20); do
       test -f /app/openhive/.run/teams/$team/memory/.bootstrapped && echo "$team BOOTSTRAPPED" && break
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

4. VERIFY two separate relay processes in logs:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser relay\|playwright.*start" | tail -10
   ```

#### Part B: Domain Isolation Between Teams

5. Send: "Ask scraper-alpha to navigate to https://example.com and report the page title."
   - VERIFY: Response mentions "Example Domain" (allowed by alpha's allowlist)

6. Send: "Ask scraper-beta to navigate to https://example.com and report the page title."
   - VERIFY: Navigation BLOCKED (example.com not in beta's `*.example.org` allowlist)
   - This proves cross-team domain isolation: alpha's allowed domains don't leak to beta

7. VERIFY process isolation inside container:
   ```bash
   sudo docker exec deployments-openhive-1 ps aux | grep -i "playwright\|chromium" | grep -v grep
   ```
   - Should show separate processes for each team (different PIDs)

#### Part C: Task Delegation with Browser + File Write

8. Send: "Ask scraper-alpha to navigate to example.com, take an accessibility snapshot, and write a summary of the page to its skills/web-summary.md file."
   - VERIFY task completed, then check host filesystem:
   ```bash
   cat /app/openhive/.run/teams/scraper-alpha/skills/web-summary.md
   ```
   - File should exist and contain content about example.com
   - This proves browser + file write work together in a delegated task

#### Part D: Main Team Without Browser

9. Send: "Navigate to example.com and tell me what the page says."
   - This goes to `main` team, which has NO browser config
   - VERIFY: Main team either routes to a browser-enabled child or reports it has no browser tools
   - Server must NOT crash — check health:
   ```bash
   curl -sf http://localhost:8080/health
   ```

**Report:** Two relay processes started? Domain isolation works (alpha=example.com OK, beta=example.com blocked)? Process isolation verified (separate PIDs)? Delegation + browser + file write work? Main team handles missing browser gracefully?
