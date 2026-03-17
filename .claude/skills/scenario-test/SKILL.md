# OpenHive Scenario Tester

Run realistic business user scenarios against a live OpenHive server to find gaps between expected and actual behavior. Each scenario simulates a real user interaction pattern and validates the complete flow — not just "did it respond" but "did it do the right thing."

## How It Works

1. **Clean start** — prune Docker, clear workspace, rebuild, wait for health
2. **Run scenarios** — send messages via CLI, check workspace/DB state after each
3. **Validate outcomes** — check tool_calls, memory files, agent definitions, triggers, org chart
4. **Report gaps** — for each failure, identify root cause and what needs fixing

## Pre-requisites

- Docker running with `docker compose -f deployments/docker-compose.yml`
- Server healthy at `http://localhost:8080/api/health`
- CLI at `cli/index.ts`

## Scenario Execution

For each scenario:
1. Print scenario name and description
2. Send messages via: `echo '<message>' | timeout 300 bun run cli/index.ts 2>&1`
   - Use 300s (5 min) timeout — complex tasks need time
   - Wait for `[Assistant]` response
3. After each message, validate expected state changes:
   - Check filesystem: `find .run/workspace -name '*.md' -o -name '*.yaml'`
   - Check DB: `docker exec openhive-root node -e "const db=require('/app/node_modules/.bun/better-sqlite3@9.6.0/node_modules/better-sqlite3')('/app/workspace/openhive.db'); <query>"`
   - Check API: `curl -sf http://localhost:8080/api/teams`, `/api/health`
   - Check container logs: `docker logs openhive-root 2>&1 | tail -50`
4. Record PASS/FAIL per validation check
5. For failures, diagnose root cause (code bug, prompt issue, tool missing, etc.)

## Scenarios

### Scenario 1: Personal Memory (basic)
**Goal:** Verify the assistant saves and recalls personal information across sessions.

```
Message 1: "Hi, I'm Sarah. I'm a product manager at TechFlow Inc in Austin, TX. I manage a team of 8 engineers."
Validate:
  - MEMORY.md exists with "Sarah", "TechFlow", "Austin"
  - save_memory tool was called (check agent_memories table)
  - Daily log has the conversation

Message 2 (new session): "What's my name and where do I work?"
Validate:
  - Response mentions "Sarah" and "TechFlow"
  - No "I don't know" or asking for info already saved
```

### Scenario 2: Agent Creation + Scheduling (the irrigation test)
**Goal:** User asks for a recurring automated task. Agent should create a subagent and register a cron trigger.

```
Message 1: "I have a HomeAssistant sprinkler system. Entity is script.lawn_irrigation. HA URL is https://ha.test.local, token is test-abc-123. Create an agent that checks Boca Raton weather every morning at 6am and decides whether to run sprinklers. If rain chance > 40%, skip. Otherwise run them."
Validate:
  - create_agent tool called (check OrgChart via API: /api/teams should show new entry)
  - Agent definition file exists with DETAILED system prompt (not just name+description)
  - Agent definition includes: HA URL, token, entity ID, decision logic, weather check
  - register_trigger tool called (check server logs for "Cron trigger registered")
  - MEMORY.md has HA config saved
  - No files in /tmp inside container
  - Only ONE agent created (not duplicates)
```

### Scenario 3: Multi-turn Task with Context
**Goal:** Verify the assistant maintains context across multiple messages in one session AND across sessions.

```
Message 1: "I'm building a REST API for a pet store. It needs endpoints for: listing pets, adding a pet, and getting a pet by ID."
Message 2: "Use Express.js with TypeScript. The database should be PostgreSQL."
Message 3: "Generate the code for the pet listing endpoint."
Validate:
  - Response references Express.js, TypeScript, PostgreSQL (from earlier messages)
  - Code is generated in workspace (not /tmp)
  - Daily log captures all 3 turns

New session:
Message 4: "What framework and database did we choose for the pet store API?"
Validate:
  - Response mentions Express.js, TypeScript, PostgreSQL
  - Retrieved from memory/daily log injection
```

### Scenario 4: Integration with External API
**Goal:** Verify the agent can actually make HTTP calls to external services.

```
Message 1: "Fetch the current weather for Boca Raton, FL from the Open-Meteo API and tell me the temperature and precipitation chance."
Validate:
  - Agent uses Bash with curl or http-client.ts to fetch weather
  - Response includes actual temperature and precipitation data (not hallucinated)
  - No "I can't make HTTP calls" response
```

### Scenario 5: Error Handling + Honest Failure
**Goal:** Verify the agent handles errors gracefully and doesn't hallucinate success.

```
Message 1: "Call the API at https://nonexistent-api.invalid/v1/data and show me the response."
Validate:
  - Agent attempts the call (uses Bash/curl)
  - Reports the actual error (DNS resolution failure, connection refused)
  - Does NOT make up a fake response
  - Does NOT claim it can't make HTTP calls
```

### Scenario 6: Tool Discovery + Correct Usage
**Goal:** Verify the agent uses MCP tools instead of writing files directly.

```
Message 1: "Save the fact that our production database is hosted at db.prod.internal:5432 to your permanent memory."
Validate:
  - save_memory tool called (check agent_memories table has entry)
  - MEMORY.md file has the content
  - Agent did NOT write to MEMORY.md directly via Write tool

Message 2: "What tools do you have available? List the MCP tools."
Validate:
  - Response lists OpenHive MCP tools (save_memory, create_agent, register_trigger, etc.)
  - Does NOT list only Claude Code built-in tools
```

## Reporting Format

```
=== OpenHive Scenario Test Results ===

Scenario 1: Personal Memory
  ✓ MEMORY.md created with personal info
  ✓ save_memory tool called
  ✓ Cross-session recall works
  Result: PASS

Scenario 2: Agent Creation + Scheduling
  ✓ create_agent called
  ✗ Agent definition missing HA credentials in system prompt
  ✗ register_trigger NOT called — used Write to create yaml instead
  Result: FAIL
    Root cause: System prompt doesn't emphasize register_trigger enough
    Fix needed: Stronger CLAUDE.md guidance for scheduling

...

Summary: 4/6 scenarios passed
Critical gaps:
  1. [description of gap + suggested fix]
  2. [description of gap + suggested fix]
```

## After Testing

If gaps are found:
1. Categorize as: code bug, prompt issue, missing tool, architecture gap
2. For each gap, suggest the minimal fix
3. Prioritize by impact (what blocks real usage vs nice-to-have)
4. Do NOT implement fixes during testing — report only
