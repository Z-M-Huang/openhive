---
paths:
  - "**/*.test.ts"
  - "backend/src/phase-gates/**"
---

# Testing Rules

- Use vitest (`describe`, `it`, `expect`, `vi.fn()`) — never jest or other test runners
- Interface-first test doubles: implement interfaces with `vi.fn()` mock objects
- No mock libraries (jest-mock-extended, sinon) — manual mocks only
- Test co-location: `foo.test.ts` next to `foo.ts`
- Tests must be deterministic — no random values, no time-dependent assertions
- Coverage: 95% for core domain (`domain/`, `control-plane/`, `executor/`, `storage/`), 80% for API/web
- Phase gate tests in `backend/src/phase-gates/layer-N.test.ts`
- When updating interfaces, update ALL mock objects that implement them
- `any` is allowed in test files for mock flexibility
