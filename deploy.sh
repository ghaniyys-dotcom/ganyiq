#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

log()  { echo "[deploy] $*"; }
error(){ echo "[deploy] ERROR: $*" >&2; exit 1; }

# ── Safe guard ──
if [[ ! -f package.json ]]; then
  error "Run deploy.sh from the project root (/root/GANYIQ)"
fi

log "Deploying GANYIQ from source ($SCRIPT_DIR)..."

# ── Quick mode — skip build ──
if [[ "${1:-}" == "--quick" ]]; then
  log "Quick deploy — skipping build."
  log "Restarting PM2..."
  pm2 restart ganyiq
  log "✅ Quick deploy complete."
  exit 0
fi

# ── Rollback mode ──
if [[ "${1:-}" == "--rollback" ]]; then
  COMMIT="${2:-HEAD~1}"
  log "Rolling back to ${COMMIT}..."
  git checkout "${COMMIT}" -- .
  log "Checked out ${COMMIT}. Proceeding with build..."
  # Fall through to full build below
fi

# ── Full deploy ──
log "Installing dependencies..."
npm ci --omit=dev 2>&1 | tail -3

log "Building production..."
npm run build 2>&1 | tail -5

log "Restarting PM2..."
pm2 restart ganyiq

log "✅ Full deploy complete."
log "Health check: curl -I https://ganyiq.ganys.me/api/health"

