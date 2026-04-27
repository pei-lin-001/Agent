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

## Next Goal

- Use the multi-agent MVP in real tasks and fix concrete failures as they appear. Avoid adding new orchestration phases until real usage exposes a specific gap.
