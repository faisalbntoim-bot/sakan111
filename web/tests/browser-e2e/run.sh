#!/usr/bin/env bash
# Browser E2E runner — real backend + real Next.js + real SQLite + real JWTs.
# No API interception, no advertisementLifecycle UPDATEs in the DB.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WEB_ROOT="$(cd "$HERE/../.." && pwd)"
BACKEND_ROOT="$(cd "$WEB_ROOT/../backend" && pwd)"
WORK="$(mktemp -d -t sakanhub-e2e.XXXXXX)"
STATE="$HERE/.e2e-state.json"

API_PORT=4101
WEB_PORT=3101
JWT_SECRET="e2e-browser-secret-at-least-32-chars-long-xxxxx"
JWT_ISSUER="sakanhub-backend"
DATABASE_URL="file:${WORK}/e2e.db"

cleanup() {
  set +e
  [ -n "${BACKEND_PID:-}" ] && kill "$BACKEND_PID" 2>/dev/null
  [ -n "${WEB_PID:-}" ] && kill "$WEB_PID" 2>/dev/null
  wait 2>/dev/null
  rm -f "$STATE"
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "[e2e] prisma db push → fresh SQLite at $DATABASE_URL"
rm -f "${DATABASE_URL#file:}"
(cd "$BACKEND_ROOT" && DATABASE_URL="$DATABASE_URL" npx prisma db push --skip-generate --accept-data-loss) \
  >> "$WORK/prisma.log" 2>&1

echo "[e2e] build web TWICE — first prod (no E2E flag) to prove tree-shake, then e2e (with flag) for the live server"
# 1) Prod build with the flag explicitly `false`. Terser folds
#    `"false" === 'true'` to a constant and strips the bridge code.
#    (If the flag were simply unset, Next would leave the env read as
#    a runtime check and the dead branch would ship — see REVIEW for
#    the chunk-grep that caught this.)
(cd "$WEB_ROOT" && NEXT_PUBLIC_SAKAN_E2E=false \
  NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:${API_PORT}" npx next build) \
  >> "$WORK/next-build-prod.log" 2>&1
rm -rf "$WEB_ROOT/.next-prod-check"
mkdir -p "$WEB_ROOT/.next-prod-check/static"
cp -r "$WEB_ROOT/.next/static/chunks" "$WEB_ROOT/.next-prod-check/static/chunks"
rm -rf "$WEB_ROOT/.next"

# 2) E2E build with the flag — this is what the live server serves.
(cd "$WEB_ROOT" && NEXT_PUBLIC_SAKAN_E2E=true \
  NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:${API_PORT}" npx next build) \
  >> "$WORK/next-build-e2e.log" 2>&1

echo "[e2e] starting backend on :$API_PORT (local storage so <video> can fetch over HTTP)"
mkdir -p "$WORK/media"
(cd "$BACKEND_ROOT" && \
  PORT="$API_PORT" \
  NODE_ENV=development \
  JWT_SECRET="$JWT_SECRET" \
  JWT_ISSUER="$JWT_ISSUER" \
  DATABASE_URL="$DATABASE_URL" \
  STORAGE_PROVIDER=local \
  LOCAL_STORAGE_DIR="$WORK/media" \
  MEDIA_UPLOAD_SIGNING_SECRET="e2e-upload-signing-secret-at-least-32-chars-long-xxx" \
  CORS_ALLOWED_ORIGINS="http://127.0.0.1:${WEB_PORT},http://localhost:${WEB_PORT}" \
  BOOKING_ALLOW_MONTHLY_TO_DAILY=true \
  BOOKING_MONTH_TO_DAY_DIVISOR=30 \
  BOOKING_DRAFT_TTL_MINUTES=15 \
  BOOKING_PENDING_TTL_MINUTES=30 \
  SMS_PROVIDER=console \
  npx tsx src/main.ts) >> "$WORK/backend.log" 2>&1 &
BACKEND_PID=$!

echo "[e2e] waiting for backend"
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1 \
   || curl -sf "http://127.0.0.1:${API_PORT}/" >/dev/null 2>&1 \
   || curl -s "http://127.0.0.1:${API_PORT}/v1/properties/feed" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "[e2e] seeding owner + admin + draft property"
(cd "$WEB_ROOT" && \
  JWT_SECRET="$JWT_SECRET" JWT_ISSUER="$JWT_ISSUER" DATABASE_URL="$DATABASE_URL" \
  node tests/browser-e2e/seed.mjs) >> "$WORK/seed.log" 2>&1

echo "[e2e] seeding booking fixture (published property + customer user)"
(cd "$WEB_ROOT" && \
  JWT_SECRET="$JWT_SECRET" JWT_ISSUER="$JWT_ISSUER" DATABASE_URL="$DATABASE_URL" \
  node tests/browser-e2e/booking-seed.mjs) >> "$WORK/seed.log" 2>&1

echo "[e2e] starting next on :$WEB_PORT"
(cd "$WEB_ROOT" && \
  NEXT_PUBLIC_SAKAN_E2E=true \
  NEXT_PUBLIC_API_BASE_URL="http://127.0.0.1:${API_PORT}" \
  npx next start -p "$WEB_PORT") >> "$WORK/next.log" 2>&1 &
WEB_PID=$!

echo "[e2e] waiting for next"
for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${WEB_PORT}/ar" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

echo "[e2e] running Playwright"
(cd "$WEB_ROOT" && \
  PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers \
  SAKAN_WEB_BASE="http://127.0.0.1:${WEB_PORT}" \
  SAKAN_API_BASE="http://127.0.0.1:${API_PORT}" \
  SAKAN_BACKEND_LOG="${WORK}/backend.log" \
  npx playwright test --config=./playwright.e2e.config.ts)
RC=$?

if [ "$RC" -ne 0 ]; then
  echo "[e2e] FAILED — last 40 lines of each log:"
  for f in prisma next-build backend seed next; do
    echo "---- $f.log ----"; tail -40 "$WORK/$f.log" 2>/dev/null || true
  done
fi
exit "$RC"
