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

## Next Goal

- Multi-agent collaborative orchestration layer.