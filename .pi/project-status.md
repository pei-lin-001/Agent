# Project Status

Facts about the current state of this project. Updated after each milestone.

## Completed

- mem0-compatible local long-term memory system integrated (`.pi/extensions/mem0-memory.ts`).
- Memory system uses Ollama Cloud for memory distillation (LLM: `qwen3-coder-next`).
- Embedding uses SiliconFlow BAAI/bge-m3.
- Durable long-task system integrated (`.pi/extensions/long-task-runner.ts`), supports `/task` commands and `long_task` tool.
- long_task passed real LLM tool-call tests.
- Ollama Cloud added as native provider in `packages/ai` and `packages/coding-agent`.
- Ollama Cloud provider id is `ollama-cloud`, default model is `qwen3-coder-next`, environment variable is `OLLAMA_API_KEY`.
- Latest commit: `64ddf64b feat(agent): make Ollama Cloud a built-in provider`, pushed to `origin/main`.
- Multi-agent orchestration MVP is implemented at the planning layer:
  - `classifyAgentRequest`, `recommendAgentDispatch`, and `buildAgentStepDrafts` classify multi-agent work and draft worker-role steps.
  - `long_task` stores `sourcePrompt`/`originalPrompt`, supports `suggest_steps` and `add_suggested_steps`, and displays worker metadata, step artifacts, progress, and resume guidance.
  - `.pi/extensions/worker-executor.ts` provides an experimental synchronous worker executor for researcher/coder/tester/reviewer/docWriter roles, with persistence failure reporting, artifact dedupe, result-order preservation, and post-run scope validation.
  - `ollama-cloud/kimi-k2.6` real smoke passed on 2026-04-27: created a short-goal `MVP` task, preserved the original prompt, added researcher/coder/tester/reviewer steps through `add_suggested_steps`, and did not execute any step.
- All multi-agent MVP tests pass (2026-04-27 verified):
  - `multi-agent-dispatcher.test.ts`: 25/25 pass.
  - `worker-executor.test.ts`: 31/31 pass.
  - Both extensions register as `.pi/extensions` auto-discovered modules with no-op default factories.
- `mem0_server.py` extended with `DELETE /memories/{id}` (with `ValueError` fallback to vector store) and `PUT /memories/{id}` endpoints.
- `mem0-memory.ts` extension now supports automatic stale memory cleanup:
  - Per-turn: after `addMemory`, searches with user+assistant query, then uses LLM-based `/dedup` endpoint to identify superseded/contradicted memories before deleting them. Falls back to score-based threshold if LLM call fails.
  - Session-start: `runFullDedup()` sweeps 5 seed queries, deletes stale duplicates across all topics.
  - `before_agent_start`: `await writeQueue` before searching, preventing stale data from race conditions.
  - Time-based decay: memories' search scores decay exponentially with age (30-day half-life). Older memories rank lower without manual deletion.
  - `addMemory` uses 60s timeout (LLM fact extraction can be slow).
  - Timeout/abort errors do not trigger the 60s cooldown (only persistent errors do).
  - `DEFAULT_CONFIG.requestTimeoutMs` raised from 3000 to 10000.
- Extension load fault tolerance: failed extensions are skipped as warnings instead of crashing the agent (changed diagnostic level from `error` to `warning`).
- `mem0_server.py` now has `/dedup` endpoint that calls Ollama Cloud LLM directly to analyze whether candidate memories contradict or are superseded by a new fact.
- Latest commit: `3f06af35 feat(agent): stabilize multi-agent planning MVP`.
- pi-rescue independent crash recovery system implemented:
  - `~/pi-rescue/pi-rescue.sh`: ~350 lines of POSIX shell, zero external dependencies.
  - 5-level recovery strategy: health check → kill stuck process → repair config → restart → safe mode.
  - Commands: `check`, `repair`, `restart`, `full`, `crashlog`, `status`, `safe-mode`, `enable-extensions`.
  - Config file repair: validate JSON → restore from `.bak` → reset to `{}`.
  - Session repair: quarantine bad JSONL headers to `.broken`.
  - Extension triage: disable optional extensions in safe mode (never disables `long-task-runner`, `mem0-memory`, `personal-profile`, `multi-agent-dispatcher`, `worker-executor`).
  - mem0 service management: health check + restart via `mem0-service.sh`.
  - macOS notification on recovery actions via `osascript`.
  - Crash log rotation when >1MB.
  - Main system hooks added: `uncaughtException` and `unhandledRejection` handlers in `cli.ts` write to `~/.pi/agent/pi-crash.log`.
  - `getCrashLogPath()` exported from `config.ts`.

## Planned Improvements

- **P2: Time-based memory decay config** — expose `decayHalfLifeDays` in config file for user customization (currently hardcoded at 30 days as default).
- **P3: Extension load fault tolerance — graceful degradation UX** — beyond not crashing, show a clear warning in the TUI when an extension fails to load, and offer a `/debug` command to inspect extension errors.

## Next Goal

- Test pi-rescue with a real pi crash scenario (e.g., corrupt settings.json, then run `pi-rescue.sh full`).
- Per-worker model selection implemented: worker agents now use different models based on task-router config.
- Self-healer extension implemented (`.pi/extensions/self-healer.ts`): auto-detects worker failures → classifies errors (permission/config/data/model/unknown) → creates repair tasks → records to mem0 → injects context at next turn.
- Feedback-loop extension implemented (`.pi/extensions/feedback-loop.ts`): detects user dissatisfaction signals in messages → classifies correction type (data_accuracy/aesthetic_quality/completeness/understanding/system_design) → records to mem0 → injects correction history at next turn → escalates 3× same type to repair task.
- All workers have full tool access (7 tools each), researcher can now use bash+curl for web search.
- kimi-2.6 multimodal image review workflow established: max_tokens >= 8000 for thinking models.
- Use the multi-agent MVP in real tasks and fix concrete failures as they appear.
