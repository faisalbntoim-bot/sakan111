#!/usr/bin/env bash
# .devcontainer/postStart.sh — launches backend + web for the SakanHub preview.
#
# This script runs on EVERY Codespace start, including after a stop/start
# cycle. It is idempotent: if a previous instance is still running on 4000
# or 3000, we skip the respective launch instead of double-forking.
#
# Both processes run in the background with their stdout/stderr redirected
# to preview-data/logs/. The container stays alive as long as the
# Codespace itself does; the processes are reaped when the container stops.
#
# Why we DO auto-start here: the operator asked for a URL they can open
# on an iPhone without typing commands. The one trade-off is that stdout
# is written to a log file (not the terminal). Tail it with:
#     tail -f preview-data/logs/backend.log
#     tail -f preview-data/logs/web.log
#
# Guards still active inside the running processes:
#   - PAYMENT_PROVIDER=sandbox and SMS_PROVIDER=console are REFUSED by
#     src/config.ts under NODE_ENV=production and (for SMS) by a runtime
#     guard inside src/auth/sms/console.ts. The .env variables below set
#     NODE_ENV=development, so this preview behaves as a dev run even
#     when deployed to a Codespace that other code might treat as a
#     "deployed environment".

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DATA="$ROOT/preview-data"
LOGS="$DATA/logs"
MEDIA="$DATA/media"
BACKEND="$ROOT/backend"
WEB="$ROOT/web"

mkdir -p "$LOGS"

# shellcheck disable=SC1091
if [ -f "$DATA/.secrets.env" ]; then . "$DATA/.secrets.env"; else
  echo "[postStart] FATAL: $DATA/.secrets.env missing — run postCreate first."; exit 1; fi
# shellcheck disable=SC1091
if [ -f "$DATA/preview.env" ]; then . "$DATA/preview.env"; else
  echo "[postStart] FATAL: $DATA/preview.env missing — run postCreate first."; exit 1; fi

# ----- helper: is a port occupied by one of our processes? ------------
is_listening() {
  local port="$1"
  # ss -ltn prints "LISTEN 0 ... 127.0.0.1:4000 ..." etc. Grep is enough —
  # we don't need PID matching since the Codespace is single-tenant.
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE ":${port}\$"
}

# ----- backend (127.0.0.1:4000) ---------------------------------------
if is_listening 4000; then
  echo "[postStart] backend already listening on 4000, skipping launch."
else
  echo "[postStart] launching backend → $LOGS/backend.log"
  (
    cd "$BACKEND"
    PORT=4000 \
    NODE_ENV=development \
    JWT_SECRET="$SAKAN_JWT_SECRET" \
    JWT_ISSUER=sakanhub-backend \
    DATABASE_URL="$SAKAN_PREVIEW_DB_URL" \
    STORAGE_PROVIDER=local \
    LOCAL_STORAGE_DIR="$SAKAN_PREVIEW_MEDIA_DIR" \
    MEDIA_UPLOAD_SIGNING_SECRET="$SAKAN_MEDIA_UPLOAD_SIGNING_SECRET" \
    CORS_ALLOWED_ORIGINS="http://127.0.0.1:3000,http://localhost:3000,$SAKAN_PREVIEW_PUBLIC_URL" \
    PAYMENT_PROVIDER=sandbox \
    SMS_PROVIDER=console \
    BOOKING_ALLOW_MONTHLY_TO_DAILY=true \
    BOOKING_MONTH_TO_DAY_DIVISOR=30 \
    BOOKING_DRAFT_TTL_MINUTES=15 \
    BOOKING_PENDING_TTL_MINUTES=30 \
    nohup npx tsx src/main.ts >> "$LOGS/backend.log" 2>&1 &
    disown
  )
  # Give it a moment and verify it bound.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if is_listening 4000; then break; fi
  done
  if ! is_listening 4000; then
    echo "[postStart] backend failed to bind within 10s — see $LOGS/backend.log"
    tail -n 40 "$LOGS/backend.log" 2>/dev/null || true
    exit 1
  fi
fi

# ----- web (0.0.0.0:3000, via next start) -----------------------------
if is_listening 3000; then
  echo "[postStart] web already listening on 3000, skipping launch."
else
  echo "[postStart] launching web → $LOGS/web.log"
  (
    cd "$WEB"
    NEXT_PUBLIC_API_BASE_URL="$SAKAN_PREVIEW_PUBLIC_URL" \
    SAKAN_PREVIEW_PROXY=1 \
    NEXT_PUBLIC_SAKAN_E2E=true \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    nohup npx next start -p 3000 -H 0.0.0.0 >> "$LOGS/web.log" 2>&1 &
    disown
  )
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    sleep 1
    if is_listening 3000; then break; fi
  done
  if ! is_listening 3000; then
    echo "[postStart] web failed to bind within 10s — see $LOGS/web.log"
    tail -n 40 "$LOGS/web.log" 2>/dev/null || true
    exit 1
  fi
fi

echo ""
echo "============================================================"
echo " SakanHub preview is up."
echo "   Public URL:  $SAKAN_PREVIEW_PUBLIC_URL"
echo "   Backend:     127.0.0.1:4000 (NOT forwarded — proxied by /v1/*)"
echo "   Logs:        $LOGS/{backend,web}.log"
echo "============================================================"
