#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PID_FILE=".pi/memory/mem0.pid"
LOG_FILE=".pi/memory/mem0.log"
HEALTH_URL="${MEM0_HEALTH_URL:-http://127.0.0.1:${MEM0_PORT:-8000}/health}"

mkdir -p .pi/memory

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

wait_until_healthy() {
  for _ in $(seq 1 30); do
    if curl -sS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_service() {
  if is_running; then
    echo "mem0 service already running: pid $(cat "$PID_FILE")"
    return 0
  fi

  nohup ./.pi/mem0-start.sh >"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"

  if wait_until_healthy; then
    echo "mem0 service started: pid $(cat "$PID_FILE")"
    return 0
  fi

  echo "mem0 service failed to become healthy. Last log lines:" >&2
  tail -80 "$LOG_FILE" >&2 || true
  return 1
}

stop_service() {
  if ! is_running; then
    echo "mem0 service is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid"
  for _ in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "mem0 service stopped"
      return 0
    fi
    sleep 1
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "mem0 service killed"
}

status_service() {
  if is_running; then
    if curl -sS --max-time 1 "$HEALTH_URL" >/dev/null 2>&1; then
      echo "mem0 service running and healthy: pid $(cat "$PID_FILE")"
    else
      echo "mem0 service process exists but health check failed: pid $(cat "$PID_FILE")"
      return 1
    fi
  else
    echo "mem0 service is not running"
    return 1
  fi
}

case "${1:-status}" in
  start)
    start_service
    ;;
  stop)
    stop_service
    ;;
  restart)
    stop_service
    start_service
    ;;
  status)
    status_service
    ;;
  logs)
    tail -f "$LOG_FILE"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs}" >&2
    exit 2
    ;;
esac
