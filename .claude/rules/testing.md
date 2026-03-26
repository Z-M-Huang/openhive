# OpenHive Testing Rules

## Test Philosophy
- Tests MUST validate real logic, not mocked behavior
- String-matching on error messages is fragile — prefer typed error checks
- Test files live next to the modules they test; E2E tests live in `e2e/`

## Coverage Requirements
- Every new callback/option added to `TaskConsumer` or adapters MUST have a unit test
- Channel adapter tests MUST verify progress/ack behavior, not just final response
- Hook tests MUST verify both allow and deny paths
