# Mem0 Memory Extension

This project uses `.pi/extensions/mem0-memory.ts` as a background long-term memory layer.

The extension is intentionally silent:

- Before each agent turn, it searches a self-hosted mem0 REST endpoint and injects relevant memories into the system prompt.
- After each successful turn, it sends the user/assistant exchange to mem0 for automatic memory extraction.
- If mem0 is not running or is not configured, it backs off and does not interrupt normal agent work.

## Configuration

Copy `.pi/memory.config.example.json` to `.pi/memory.config.json` for project-specific settings.

The real `.pi/memory.config.json` file is ignored by Git so local endpoints, user IDs, or secrets are not committed.

Global config is also supported at:

```text
~/.pi/agent/memory.config.json
```

Project config overrides global config. Environment variables override defaults when a config field is absent:

- `MEM0_BASE_URL`
- `MEM0_API_KEY`
- `MEM0_USER_ID`
- `MEM0_AGENT_ID`

For authenticated local servers, set `apiKey` to an environment variable name or use `apiKeyCommand` to read from a local secret store such as macOS Keychain.

## Self-Hosted Requirement

This extension does not call mem0's hosted service. It expects a self-hosted mem0-compatible REST server with:

- `POST /search`
- `POST /memories`

Both paths can be changed in the config file.

## Local Service

This repo includes a local mem0-compatible service wrapper:

```bash
uv venv --python /Users/shelterpl/.local/bin/python3.12 --seed .pi/memory/venv
.pi/memory/venv/bin/python -m pip install -r .pi/mem0-requirements.txt
.pi/mem0-start.sh
```

It reads secrets from macOS Keychain by default:

- `mem0-admin-api-key`
- `ollama-cloud-api-key`
- `siliconflow-api-key`

Default model choices:

- LLM: `qwen3-coder-next` via Ollama Cloud
- Embedding: `BAAI/bge-m3` via SiliconFlow
- Vector store: local Qdrant files under `.pi/memory/data`

The real runtime files under `.pi/memory/` are ignored by Git.

Service management:

```bash
.pi/mem0-service.sh start
.pi/mem0-service.sh status
.pi/mem0-service.sh stop
.pi/mem0-service.sh logs
```

## Verification

Run the focused regression test from the coding-agent package:

```bash
cd packages/coding-agent
npx tsx ../../node_modules/vitest/dist/cli.js --run test/suite/mem0-memory-extension.test.ts
```

The test starts a fake mem0-compatible server and verifies memory search injection, turn write-back, and unavailable-service fallback.
