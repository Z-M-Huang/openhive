# Scenario 1: Core Platform (Identity + Memory + Injection + Recovery)

**Run the Clean Restart Helper from setup.md. Then reset harness and reconnect:**
```bash
curl -s localhost:9876/reset
curl -s localhost:9876/connect -d '{"name":"main"}'
```

#### Part A: Identity & Tools

1. ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"Who are you and what system do you run?","timeout":300000}'
   ```
   VERIFY: `.final` mentions OpenHive or agent orchestration (not generic "I'm Claude")

2. ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"What tools do you have access to? List them.","timeout":300000}'
   ```
   VERIFY: `.final` mentions team management tools (spawn_team, delegate_task, list_teams, etc.)
   VERIFY: `.final` mentions get_credential tool (the 10th org tool)
   VERIFY: `curl -s localhost:9876/notifications -d '{"name":"main"}'` → count: 0 (no unexpected async)
   VERIFY: Container logs have no errors

#### Part B: Memory Persistence

3. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"My name is Mark and I work at Acme Corp. Please save this to your memory file.","timeout":300000}
   EOF
   ```
   - VERIFY RESPONSE: `.final` acknowledges saving
   - VERIFY HOST FILESYSTEM: `cat /app/openhive/.run/teams/main/memory/MEMORY.md`
     - Does file exist? Does it contain "Mark" and "Acme"?
     - If missing: **INVESTIGATE** — check Write tool access, check container logs

4. ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"What is my name?","timeout":300000}'
   ```
   - VERIFY: `.final` says "Mark"
   - If it doesn't know: check MEMORY.md content
     - If "Mark" IS in MEMORY.md: memory injection broken -> check context-builder.ts
     - If "Mark" NOT in MEMORY.md: agent didn't save correctly

5. `sudo docker restart openhive` — wait for health, then reconnect:
   ```bash
   for i in $(seq 1 30); do curl -sf http://localhost:8080/health >/dev/null 2>&1 && echo "Ready" && break; sleep 3; done
   curl -s localhost:9876/reconnect -d '{"name":"main"}'
   ```

6. ```bash
   curl -s localhost:9876/send -d @- <<'EOF'
   {"name":"main","content":"What is my name and where do I work?","timeout":300000}
   EOF
   ```
   - VERIFY: `.final` says Mark + Acme (cross-session persistence via MEMORY.md)
   - VERIFY: MEMORY.md still on disk after restart

#### Part C: Skill, Rule & Memory Injection

7. Write injection files on HOST:
   ```bash
   echo "Always say PINEAPPLE when greeting" > /app/openhive/.run/teams/main/skills/greeting.md
   echo "End every response with -- OpenHive" > /app/openhive/.run/teams/main/team-rules/sig.md
   echo "My favorite color is TURQUOISE" > /app/openhive/.run/teams/main/memory/MEMORY.md
   ```

8. ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"Greet me","timeout":300000}'
   ```
   - VERIFY: `.final` contains PINEAPPLE

9. ```bash
   curl -s localhost:9876/send -d '{"name":"main","content":"Say hello","timeout":300000}'
   ```
   - VERIFY: `.final` ends with "-- OpenHive"

10. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"What is my favorite color?","timeout":300000}'
    ```
    - VERIFY: `.final` mentions TURQUOISE

11. Remove all injection files:
    ```bash
    rm /app/openhive/.run/teams/main/skills/greeting.md
    rm /app/openhive/.run/teams/main/team-rules/sig.md
    rm /app/openhive/.run/teams/main/memory/MEMORY.md
    ```

12. ```bash
    curl -s localhost:9876/send -d '{"name":"main","content":"What is my favorite color?","timeout":300000}'
    ```
    - VERIFY: `.final` should NOT mention TURQUOISE (memory gone)

**Report:** Identity correct? Tools listed (including get_credential)? Memory persisted across restart? All 3 injection types worked? Injection removal worked?
