# Test Task 3: Safe Refactor of Multi-Agent Dispatcher

## Prompt
"Refactor .pi/extensions/multi-agent-dispatcher.ts to extract the STEP_DRAFT_TEMPLATES
into a separate function that takes a config parameter, run the test suite, and review."

## Classification
- **Mode:** multi_agent_candidate
- **Action:** plan_multi_agent

## Allowed Scope
- `.pi/extensions/multi-agent-dispatcher.ts` (edit only)
- `packages/coding-agent/test/suite/` (test commands only)

## Expected Worker Plan
1. **researcher** — Review current STEP_DRAFT_TEMPLATES usage and callers
2. **coder** — Extract into configurable function, keep interface compatible
3. **tester** — Run `npx vitest run packages/coding-agent/test/suite/long-task-runner-extension.test.ts`
4. **reviewer** — Review refactored code for correctness

## Expected Test Commands
```bash
npx vitest run packages/coding-agent/test/suite/long-task-runner-extension.test.ts
```

## Acceptance Criteria
1. All existing dispatcher tests pass
2. New function is parameterized by config
3. No behavioral changes to existing callers
4. Reviewer output lists no issues
