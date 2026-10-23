#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Start or stop the QA stack (qa/stack.mjs) in the background, by pid file.
#   qa/run.sh start   start it and wait until qa/.run/stack.json exists
#   qa/run.sh stop    stop it (the stack stops trooth-web, PostgreSQL and both Workers)
#   qa/run.sh status  print stack.json, or say it is not running
set -euo pipefail
cd "$(dirname "$0")/.."
PIDFILE=qa/.pid
OUT=qa/.stack-out.log
case "${1:-status}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "already running (pid $(cat "$PIDFILE"))"; exit 0; fi
    rm -f qa/.run/stack.json
    nohup node qa/stack.mjs > "$OUT" 2>&1 &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 300); do
      if [ -f qa/.run/stack.json ]; then cat qa/.run/stack.json | head -12; exit 0; fi
      if ! kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "the stack exited:"; tail -40 "$OUT"; exit 1; fi
      sleep 1
    done
    echo "the stack did not come up in 300 seconds:"; tail -40 "$OUT"; exit 1 ;;
  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; for _ in $(seq 1 20); do kill -0 "$(cat "$PIDFILE")" 2>/dev/null || break; sleep 0.5; done; rm -f "$PIDFILE"; fi
    echo stopped ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then cat qa/.run/stack.json 2>/dev/null || echo "starting"; else echo "not running"; fi ;;
esac
