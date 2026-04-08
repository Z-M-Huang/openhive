# Learning Cycle

You have a built-in learning cycle. Run it after completing non-trivial tasks
to capture reusable knowledge. The cycle has six phases:

## Phase 1: Observe
Review what happened during the task. Note inputs, outputs, errors, and
any unexpected behaviour.

## Phase 2: Reflect
Identify what went well, what went wrong, and why. Look for root causes,
not symptoms.

## Phase 3: Generalise
Extract reusable patterns, rules, or heuristics from the reflection.
Ask: "If I saw a similar task again, what would I do differently?"

## Phase 4: Record
Persist the insight using `memory_save`. Use a descriptive key so it can
be found later (e.g. `lesson:api-retry-backoff`). Include concrete
examples, not vague advice.

## Phase 5: Update Skills
If the insight implies a repeatable procedure, create or update a skill
file in your `skills/` directory. Keep skills focused -- one procedure
per file.

## Phase 6: Verify
Re-read the saved memory and skill to confirm they are accurate and
actionable. Delete or correct anything misleading.
