# Scenario 10: Idle Cleanup & Restart Persistence

**Continues from Scenario 9 — NO clean restart.**

#### Part A: Idle TTL Cleanup

1. Record browser processes before idle wait:
   ```bash
   sudo docker exec deployments-openhive-1 ps aux | grep -i "playwright\|chromium" | grep -v grep | wc -l
   echo "Browser processes BEFORE idle wait"
   ```

2. Poll for idle TTL cleanup (check every 30s, max 7 min):
   ```bash
   echo "Polling for idle TTL cleanup (max 420s)..."
   for i in $(seq 1 14); do
     COUNT=$(sudo docker exec deployments-openhive-1 ps aux | grep -i "playwright\|chromium" | grep -v grep | wc -l)
     echo "  Check $i: $COUNT browser processes"
     if [ "$COUNT" -eq 0 ]; then echo "CLEANUP_DETECTED after $((i*30))s"; break; fi
     sleep 30
   done
   ```

3. VERIFY browser processes cleaned up:
   ```bash
   AFTER=$(sudo docker exec deployments-openhive-1 ps aux | grep -i "playwright\|chromium" | grep -v grep | wc -l)
   echo "Browser processes AFTER idle wait: $AFTER"
   ```
   - Count should be 0 (or fewer than step 1)
   - If still running after 7 min: **INVESTIGATE** — check TTL config, relay cleanup logic
   - Check logs for cleanup:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "idle\|cleanup\|ttl" | tail -10
   ```

4. Health still OK:
   ```bash
   curl -sf http://localhost:8080/health
   ```

5. VERIFY on-demand re-spawn — send a browser request after cleanup:
   Send: "Ask scraper-alpha to navigate to https://example.com and report the title."
   - VERIFY: Task completes successfully (relay re-spawned on demand)
   - Check logs for relay restart:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser relay.*start\|spawn.*playwright" | tail -5
   ```

   **PASS**: Idle cleanup happened (count decreased), then browser restarted on demand
   **FAIL**: Processes never cleaned up, or browser fails to restart after cleanup

#### Part B: Restart Persistence

6. Restart container:
   ```bash
   sudo docker restart deployments-openhive-1
   for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
   ```

7. VERIFY team configs survived restart:
   ```bash
   cat /app/openhive/.run/teams/scraper-alpha/config.yaml | grep -A5 "browser"
   cat /app/openhive/.run/teams/scraper-beta/config.yaml | grep -A5 "browser"
   ```
   - Both should still have `browser:` sections intact

8. VERIFY org tree survived:
   ```bash
   node -e "
   const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
   console.log(JSON.stringify(D.prepare('SELECT name FROM org_tree').all()));
   D.close();
   "
   ```
   - Should list scraper-alpha and scraper-beta

9. VERIFY browser relay re-discovery on startup:
   ```bash
   sudo docker logs deployments-openhive-1 2>&1 | grep -i "browser\|relay\|playwright" | tail -10
   ```
   - Logs should show browser relay available (lazy-start on first request is acceptable)

10. Send: "Ask scraper-alpha to navigate to https://example.com and report the page title."
    - VERIFY: Response mentions "Example Domain" (browser tools work after restart)

11. Final health check:
    ```bash
    curl -sf http://localhost:8080/health | python3 -m json.tool
    ```

#### Part C: Cleanup

12. Shut down browser teams:
    Send: "Shut down scraper-alpha"
13. Send: "Shut down scraper-beta"
14. VERIFY both removed from org_tree:
    ```bash
    node -e "
    const D = require('/app/openhive/backend/node_modules/better-sqlite3')('/app/openhive/.run/openhive.db', {readonly:true});
    console.log(JSON.stringify(D.prepare('SELECT name FROM org_tree').all()));
    D.close();
    "
    ```
    - Neither scraper-alpha nor scraper-beta should appear
15. Health still OK:
    ```bash
    curl -sf http://localhost:8080/health
    ```

**Report:** Idle TTL cleanup worked (process count decreased)? Browser re-activates on demand after cleanup? Config survived restart? Org tree survived? Browser tools functional after restart? Teams cleaned up?
