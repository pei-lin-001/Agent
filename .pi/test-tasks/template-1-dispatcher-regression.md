# Test Task 1: Dispatcher Regression Test

## Prompt
"Modify .pi/extensions/multi-agent-dispatcher.ts to add a new signal pattern for 'performance optimization',
then run vitest to verify the dispatcher tests still pass, and review the diff for regressions."

## Classification
- **Mode:** multi_agent_candidate
- **Action:** plan_multi_agent

## Allowed Scope
- `.pi/extensions/multi-agent-dispatcher.ts` (edit)
- `packages/coding-agent/test/suite/` (test commands only)

## Expected Worker Plan
1. **researcher** — Review current dispatcher signal patterns in `MULTI_AGENT_PATTERNS` and test coverage
2. **coder** — Add new signal pattern for "performance optimization", keep existing tests passing
3. **tester** — Run `npx vitest run packages/coding-agent/test/suite/long-task-runner-extension.test.ts`
4. **reviewer** — Review diff for regressions, check test coverage gaps

## Expected Test Commands
```bash
npx vitest run packages/coding-agent/test/suite/long-task-runner-extension.test.ts
```

## Acceptance Criteria
1. All existing dispatcher-related tests pass
2. New signal pattern correctly classifies "performance optimization" prompts as multi_agent_candidate
3. Reviewer output lists no regressions
4. Changed files tracked in step artifacts
