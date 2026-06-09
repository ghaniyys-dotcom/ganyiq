#!/usr/bin/env bash
set -euo pipefail

# Phase 3C — Final validation runner
# Wraps the Python script and injects API keys from env

# Read API key from .env.local
LLM_KEY=$(grep "^OPENCODE_GO_API_KEY=" /root/GANYIQ/.env.local | sed 's/OPENCODE_GO_API_KEY=//')

if [ -z "$LLM_KEY" ]; then
    echo "ERROR: No OpenCode API key found"
    exit 1
fi

export OPENCODE_GO_API_KEY="$LLM_KEY"

cd /root/GANYIQ
python3 scripts/phase3c-final.py
