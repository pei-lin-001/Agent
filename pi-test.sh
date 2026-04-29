#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check for --no-env and --no-ext flags
NO_EXT=false
NO_ENV=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  elif [[ "$arg" == "--no-ext" ]]; then
    NO_EXT=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see packages/ai/src/env-api-keys.ts)
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_OAUTH_TOKEN
  unset OPENAI_API_KEY
  unset GEMINI_API_KEY
  unset GROQ_API_KEY
  unset CEREBRAS_API_KEY
  unset XAI_API_KEY
  unset OPENROUTER_API_KEY
  unset ZAI_API_KEY
  unset MISTRAL_API_KEY
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY
  unset AI_GATEWAY_API_KEY
  unset OPENCODE_API_KEY
  unset COPILOT_GITHUB_TOKEN
  unset GH_TOKEN
  unset GITHUB_TOKEN
  unset GOOGLE_APPLICATION_CREDENTIALS
  unset GOOGLE_CLOUD_PROJECT
  unset GCLOUD_PROJECT
  unset GOOGLE_CLOUD_LOCATION
  unset AWS_PROFILE
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  unset AWS_REGION
  unset AWS_DEFAULT_REGION
  unset AWS_BEARER_TOKEN_BEDROCK
  unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI
  unset AWS_WEB_IDENTITY_TOKEN_FILE
  unset AZURE_OPENAI_API_KEY
  unset AZURE_OPENAI_BASE_URL
  unset AZURE_OPENAI_RESOURCE_NAME
  echo "Running without API keys..."
fi

TSX_BIN="$SCRIPT_DIR/node_modules/.bin/tsx"
if [[ ! -x "$TSX_BIN" ]]; then
  echo "tsx not found at $TSX_BIN. Run npm install from the repo root first." >&2
  exit 1
fi

# ── Start extension dependencies ────────────────────────────────────────────
MEM0_SERVICE_SCRIPT="$SCRIPT_DIR/.pi/mem0-service.sh"
MEM0_PID=""

if [[ "$NO_EXT" == "false" ]]; then
  echo "=== Starting extension dependencies ==="

  # mem0 long-term memory service
  if [[ -x "$MEM0_SERVICE_SCRIPT" ]]; then
    echo "[mem0] starting long-term memory service..."
    if "$MEM0_SERVICE_SCRIPT" start 2>&1; then
      echo "[mem0] service is ready"
      MEM0_PID="$(cat "$SCRIPT_DIR/.pi/memory/mem0.pid" 2>/dev/null || true)"
    else
      echo "[mem0] WARNING: failed to start, memory extension will degrade gracefully"
    fi
  else
    echo "[mem0] service script not found, skipping"
  fi

  echo "=== All extension dependencies started ==="
  echo ""
fi

# ── Run pi ──────────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  echo "pi-test exiting."
  if [[ -n "$MEM0_PID" ]] && kill -0 "$MEM0_PID" 2>/dev/null; then
    echo "[mem0] service still running (pid $MEM0_PID). Use \"$MEM0_SERVICE_SCRIPT stop\" to stop."
  fi
}
trap cleanup EXIT

"$TSX_BIN" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
