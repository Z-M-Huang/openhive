---
paths:
  - "backend/src/mcp/**/*.ts"
---

# MCP Tools Rules

- All tools must have Zod input schemas in `TOOL_SCHEMAS`
- All tools must have descriptions in `TOOL_DESCRIPTIONS` (sdk-runner.ts)
- Tool handlers follow signature: `(args, agentAid, teamSlug) => Promise<unknown>`
- Validate authorization against org chart before execution
- Timeout tiers: query (10s), mutating (60s), blocking (5min)
- Role matrix: main_assistant (23 tools) > team_lead (20) > member (7)
- When adding a new tool: update TOOL_SCHEMAS, TOOL_DESCRIPTIONS, TOOL_COUNT, registry role sets, bridge timeout tier
- Log all tool calls with tool name, agent AID, and redacted params
- Tools return structured objects, not strings
