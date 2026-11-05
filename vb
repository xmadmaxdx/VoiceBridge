#!/usr/bin/env bash
# VoiceBridge launcher for bash / Git Bash / WSL.
set -u
root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$root/pc/bin/vb.js" "$@"
