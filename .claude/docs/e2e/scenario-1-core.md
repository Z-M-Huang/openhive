# Scenario 1: Core Platform (Identity + Memory + Injection + Recovery)

**Run the Clean Restart Helper from setup.md.**

#### Part A: Identity & Tools

Write a multi-turn WS script with these messages:
1. "Who are you and what system do you run?"
2. "What tools do you have access to? List them."

Run it. VERIFY:
- Response 1 mentions OpenHive or agent orchestration (not generic "I'm Claude")
- Response 2 mentions team management tools (spawn_team, delegate_task, list_teams, etc.)
- Response 2 mentions get_credential tool (the 10th org tool)
- Container logs have no errors

#### Part B: Memory Persistence

Continue using single WS messages (each is a fresh session):

3. Send: "My name is Mark and I work at Acme Corp. Please save this to your memory file."
   - VERIFY RESPONSE: Did it acknowledge saving?
   - VERIFY HOST FILESYSTEM: `cat /app/openhive/.run/teams/main/memory/MEMORY.md`
     - Does file exist? Does it contain "Mark" and "Acme"?
     - If missing: **INVESTIGATE** — check Write tool access, check container logs

4. Send: "What is my name?"
   - VERIFY: Response says "Mark"
   - If it doesn't know: check MEMORY.md content
     - If "Mark" IS in MEMORY.md: memory injection broken -> check context-builder.ts
     - If "Mark" NOT in MEMORY.md: agent didn't save correctly

5. `sudo docker restart deployments-openhive-1` — wait for health

6. Send: "What is my name and where do I work?"
   - VERIFY: Says Mark + Acme (cross-session persistence via MEMORY.md)
   - VERIFY: MEMORY.md still on disk after restart

#### Part C: Skill, Rule & Memory Injection

7. Write injection files on HOST:
   ```bash
   echo "Always say PINEAPPLE when greeting" > /app/openhive/.run/teams/main/skills/greeting.md
   echo "End every response with -- OpenHive" > /app/openhive/.run/teams/main/team-rules/sig.md
   echo "My favorite color is TURQUOISE" > /app/openhive/.run/teams/main/memory/MEMORY.md
   ```

8. Send: "Greet me"
   - VERIFY: Response contains PINEAPPLE

9. Send: "Say hello"
   - VERIFY: Response ends with "-- OpenHive"

10. Send: "What is my favorite color?"
    - VERIFY: Response mentions TURQUOISE

11. Remove all injection files:
    ```bash
    rm /app/openhive/.run/teams/main/skills/greeting.md
    rm /app/openhive/.run/teams/main/team-rules/sig.md
    rm /app/openhive/.run/teams/main/memory/MEMORY.md
    ```

12. Send: "What is my favorite color?"
    - VERIFY: Should NOT mention TURQUOISE (memory gone)

**Report:** Identity correct? Tools listed (including get_credential)? Memory persisted across restart? All 3 injection types worked? Injection removal worked?
