#!/usr/bin/env bash
# Point the phone at the PC over USB.
#
# adb reverse (not forward): the phone initiates the connection, so the phone's
# 127.0.0.1:<port> must be routed to the PC's <port>.
set -euo pipefail

PORT="${1:-8765}"

if ! command -v adb > /dev/null 2>&1; then
  echo "adb not found. Install Android platform-tools and put adb on PATH." >&2
  exit 1
fi

echo "== devices =="
adb devices -l

COUNT="$(adb devices | tail -n +2 | grep -c 'device$' || true)"
if [ "$COUNT" -eq 0 ]; then
  echo "" >&2
  echo "No authorized device. Plug in USB, enable Developer options," >&2
  echo "turn on USB debugging, and accept the RSA prompt on the phone." >&2
  exit 1
fi

adb reverse --remove-all > /dev/null 2>&1 || true
adb reverse "tcp:${PORT}" "tcp:${PORT}"

echo ""
echo "Reverse tunnel up: phone 127.0.0.1:${PORT} -> PC 127.0.0.1:${PORT}"
echo "In the app, host = 127.0.0.1, port = ${PORT}"
echo "Token: node pc/bin/vb.js token"
