---
paths:
  - "backend/src/**/*.ts"
---

# Backend Rules

- All external dependencies go through interfaces in `domain/interfaces.ts`
- Throw domain errors from `domain/errors.ts` — never throw plain `Error` or strings
- All public async methods must handle errors — no unhandled promise rejections
- Follow invariants INV-01 through INV-10 from CLAUDE.md
- Use `type` imports for type-only usage: `import type { X } from '...'`
- File naming: kebab-case (`container-manager.ts`, not `ContainerManager.ts`)
- No `any` in production code — use `unknown` + type guards instead of `as` casts
- Import order: node builtins → external packages → internal modules → domain types
