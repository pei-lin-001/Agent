#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export MEM0_ADMIN_API_KEY="${MEM0_ADMIN_API_KEY:-$(security find-generic-password -a "$USER" -s "mem0-admin-api-key" -w)}"
export MEM0_LLM_API_KEY="${MEM0_LLM_API_KEY:-$(security find-generic-password -a "$USER" -s "ollama-cloud-api-key" -w)}"
export MEM0_EMBEDDER_API_KEY="${MEM0_EMBEDDER_API_KEY:-$(security find-generic-password -a "$USER" -s "siliconflow-api-key" -w)}"

export MEM0_LLM_BASE_URL="${MEM0_LLM_BASE_URL:-https://ollama.com/v1}"
export MEM0_LLM_MODEL="${MEM0_LLM_MODEL:-qwen3-coder-next}"
export MEM0_EMBEDDER_BASE_URL="${MEM0_EMBEDDER_BASE_URL:-https://api.siliconflow.cn/v1}"
export MEM0_EMBEDDER_MODEL="${MEM0_EMBEDDER_MODEL:-BAAI/bge-m3}"
export MEM0_EMBEDDER_DIMS="${MEM0_EMBEDDER_DIMS:-1024}"
export MEM0_TELEMETRY="${MEM0_TELEMETRY:-false}"

exec .pi/memory/venv/bin/python -m uvicorn --app-dir .pi mem0_server:app --host 127.0.0.1 --port "${MEM0_PORT:-8000}"
