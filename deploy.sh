#!/bin/bash
# deploy.sh — Deploy GANYIQ from single source of truth to production
#
# Source of truth: /root/GANYIQ
# Production:     /var/www/ganyiq  (PM2 runs from here)
#
# Usage:
#   bash deploy.sh          — Full deploy (sync + build + restart)
#   bash deploy.sh --quick  — Quick deploy (sync only + restart, no build)
#   bash deploy.sh --build  — Build only (no sync)
#   bash deploy.sh --rollback HEAD~1 — Rollback one commit

set -euo pipefail

SOURCE="/root/GANYIQ"
TARGET="/var/www/ganyiq"
EXCLUDES="--exclude=.git --exclude=node_modules --exclude=.next --exclude=.env* --exclude=*tsbuildinfo --exclude=cookies.txt --exclude=public/clips"
RSYNC_OPTS="-av --delete $EXCLUDES"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[deploy]${NC} $1"; }
warn() { echo -e "${YELLOW}[deploy]${NC} $1"; }
err()  { echo -e "${RED}[deploy]${NC} $1"; exit 1; }

# --- Rollback mode ---
if [[ "${1:-}" == "--rollback" ]]; then
  COMMIT="${2:-HEAD~1}"
  warn "Rolling back to $COMMIT..."
  cd "$SOURCE"
  git checkout "$COMMIT"
  log "Rolled back to $(git rev-parse HEAD)"
fi

# --- Build-only mode ---
if [[ "${1:-}" == "--build" ]]; then
  log "Building production..."
  cd "$TARGET"
  npx next build
  log "Build complete."
  exit 0
fi

# --- Full sync ---
log "Syncing $SOURCE → $TARGET..."
rsync $RSYNC_OPTS "$SOURCE/" "$TARGET/"
log "Sync complete."

# --- Quick mode (no build) ---
if [[ "${1:-}" == "--quick" ]]; then
  log "Quick deploy — skipping build."
  log "Restarting PM2..."
  pm2 restart ganyiq
  log "✅ Quick deploy complete."
  exit 0
fi

# --- Build ---
log "Installing dependencies..."
cd "$TARGET"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev

log "Building production..."
if ! npx next build; then
  err "Build failed. Production NOT updated."
fi
log "Build successful."

# --- Restart ---
log "Restarting PM2..."
pm2 restart ganyiq
log "✅ Full deploy complete."

# --- Verify ---
sleep 2
if curl -sf http://localhost:3003/api/health > /dev/null 2>&1; then
  log "Health check PASSED."
else
  warn "Health check FAILED — PM2 may still be starting."
fi
