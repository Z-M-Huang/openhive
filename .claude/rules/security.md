---
paths:
  - "**/*.ts"
---

# Security Rules

- Never hardcode secrets, API keys, tokens, or passwords in source code
- Validate all input at system boundaries (API routes, WebSocket messages, tool args)
- Use Zod for runtime validation — TypeScript types alone are not sufficient
- Parameterize all database queries — no string concatenation for SQL
- Use AES-256-GCM for encryption (via KeyManager) — no custom crypto
- Sanitize file paths: reject `../` traversal, validate against workspace root
- Rate-limit public endpoints and tool invocations
- Log security events (auth failures, permission denials) — never log secrets
- WebSocket auth: one-time tokens (32 bytes hex, 5-min TTL, single-use)
- Container isolation: no ICC, all traffic through root hub (INV-02, INV-03)
