#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-Trooth-Proprietary
# Copyright (c) 2026 Trooth, LLC
#
# Run the QA walk (qa/walk/walk.mjs) in the background, by pid file.
#   qa/walk.sh start <run id> [dark|light] [sections]   a fresh stack, then the walk
#   qa/walk.sh status                                   still running, and the last lines
#   qa/walk.sh stop
set -euo pipefail
cd "$(dirname "$0")/.."
PIDFILE=qa/.walk-pid
case "${1:-status}" in
  start)
    RUN_ID="${2:?run id}"; THEME="${3:-dark}"; ONLY="${4:-}"
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo "a walk is running (pid $(cat "$PIDFILE"))"; exit 1; fi
    if [ -z "$ONLY" ]; then qa/run.sh stop >/dev/null; qa/run.sh start >/dev/null; fi
    QA_RUN_ID="$RUN_ID" QA_THEME="$THEME" QA_ONLY="$ONLY" nohup node qa/walk/walk.mjs > "qa/.walk-$RUN_ID.out" 2>&1 &
    echo $! > "$PIDFILE"
    echo "walk $RUN_ID started (pid $(cat "$PIDFILE")); output qa/.walk-$RUN_ID.out" ;;
  status)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then echo running; else echo "not running"; fi ;;
  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi; echo stopped ;;
esac
