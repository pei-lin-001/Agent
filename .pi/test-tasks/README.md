# End-to-End Test Task Templates

Reproducible test tasks for validating the multi-agent personal agent platform.

## Templates

| # | Template | What It Tests |
|---|----------|---------------|
| 1 | `template-1-dispatcher-regression.md` | Dispatcher signal patterns + test suite regression |
| 2 | `template-2-doc-update.md` | Simple documentation change with classification |
| 3 | `template-3-safe-refactor.md` | Safe refactor with scope enforcement |

## How to Use

Each template defines:
- **Prompt** — The user prompt to feed to the agent
- **Classification** — Expected dispatch mode and action
- **Allowed Scope** — Files the agent may modify
- **Expected Worker Plan** — Worker roles and their responsibilities
- **Expected Test Commands** — Commands to run for validation
- **Acceptance Criteria** — How to verify success

To run a test:
1. Read the template
2. Feed the prompt to the pi coding agent
3. Verify the agent correctly classifies the request
4. Verify worker steps are assigned correctly
5. Verify test commands pass
6. Verify acceptance criteria are met
