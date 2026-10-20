#!/usr/bin/env bash
# preview-isolated.sh — isolated, non-production preview of the
# UNIFIED (Next 15 + Moyasar adapter + console SMS) code tree.
#
# What this script does:
#   1. Isolated SQLite DB under ./preview-data/ — NEVER touches
#      /opt/sakanhub or any Postgres instance.
#   2. NODE_ENV=development so `assertProdSafety` is not activated.
#      Production guards therefore stay engaged for actual prod boots;
#      this preview does NOT disable or weaken them in prod code.
#   3. PAYMENT_PROVIDER=sandbox — all payments are mock (no card
#      tokenisation, no Moyasar network traffic). Real Moyasar remains
#      stubbed until the operator mints test keys separately per
#      docs/MOYASAR_TEST_MODE.md.
#   4. SMS_PROVIDER=console — the OTP code is printed to the backend
#      log so you can complete sign-in locally. This path refuses to
#      run under NODE_ENV=production (see src/auth/sms/console.ts
#      runtime guard plus assertProdSafety in config.ts).
#   5. Generates two 32-byte secrets locally. Nothing is uploaded.
#   6. Runs `prisma db push --skip-generate` without
#      --accept-data-loss — refuses to clobber any pre-existing DB.
#
# How to run:
#   bash preview-isolated.sh
# Then follow the TWO commands it prints — one for the backend,
# one for Next.js — and open http://127.0.0.1:3000/ar in your browser.
#
# How to stop:
#   Ctrl-C the two terminals. The DB and media live under
#   ./preview-data/; delete that folder to reset.
#
# Non-goals (explicit):
#   - No commit, push, or deploy.
#   - No real payment, real refund, real SMS.
#   - No change to any config file outside ./preview-data/.
#   - No touching of production hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
DATA="$ROOT/preview-data"
DB="$DATA/preview.db"
MEDIA="$DATA/media"
SECRETS="$DATA/.secrets.env"
BACKEND="$ROOT/backend"
WEB="$ROOT/web"

command -v node >/dev/null || { echo "node not on PATH — install Node 22+"; exit 1; }
[ -d "$BACKEND" ] || { echo "backend/ not found next to this script"; exit 1; }
[ -d "$WEB" ]     || { echo "web/ not found next to this script"; exit 1; }

mkdir -p "$DATA" "$MEDIA"

# --- Secrets (local, never committed) ------------------------------------
if [ ! -f "$SECRETS" ]; then
  echo "[preview] generating local secrets at $SECRETS"
  JWT=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  SIGN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  cat > "$SECRETS" <<EOF
# AUTO-GENERATED LOCAL PREVIEW SECRETS. Do NOT commit this file.
# Delete and rerun this script to rotate.
export SAKAN_JWT_SECRET="$JWT"
export SAKAN_MEDIA_UPLOAD_SIGNING_SECRET="$SIGN"
EOF
  chmod 600 "$SECRETS"
fi
# shellcheck disable=SC1090
. "$SECRETS"
[ -n "${SAKAN_JWT_SECRET:-}" ]                     || { echo "secrets missing"; exit 1; }
[ -n "${SAKAN_MEDIA_UPLOAD_SIGNING_SECRET:-}" ]    || { echo "secrets missing"; exit 1; }

# --- Isolated SQLite DB --------------------------------------------------
if [ -s "$DB" ]; then
  SZ=$(wc -c < "$DB")
  echo "[preview] DB already exists (${SZ} bytes) at $DB — reusing. Delete it manually to reset."
else
  echo "[preview] creating fresh preview DB at $DB"
  : > "$DB"
fi
DBURL="file:$DB"

# --- Install deps (idempotent) -------------------------------------------
[ -d "$BACKEND/node_modules" ] || (cd "$BACKEND" && npm ci)
[ -d "$WEB/node_modules" ]     || (cd "$WEB" && npm ci)

# --- Prisma: push schema to the isolated DB ------------------------------
echo "[preview] prisma db push against $DBURL (no --accept-data-loss)"
(cd "$BACKEND" && DATABASE_URL="$DBURL" npx prisma db push --skip-generate)

# --- Build the Next.js app -----------------------------------------------
echo "[preview] building Next.js (prod) with NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000"
(cd "$WEB" && NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000 npm run build)

# --- Print run commands --------------------------------------------------
cat <<EOF

============================================================
 Preview is ready. Open TWO new terminals:
============================================================

 TERMINAL 1 — backend (listens on 127.0.0.1:4000):

   cd '$BACKEND'
   . '$SECRETS'
   PORT=4000 \\
   NODE_ENV=development \\
   JWT_SECRET="\$SAKAN_JWT_SECRET" \\
   JWT_ISSUER=sakanhub-backend \\
   DATABASE_URL='$DBURL' \\
   STORAGE_PROVIDER=local \\
   LOCAL_STORAGE_DIR='$MEDIA' \\
   MEDIA_UPLOAD_SIGNING_SECRET="\$SAKAN_MEDIA_UPLOAD_SIGNING_SECRET" \\
   CORS_ALLOWED_ORIGINS=http://127.0.0.1:3000,http://localhost:3000 \\
   PAYMENT_PROVIDER=sandbox \\
   SMS_PROVIDER=console \\
   BOOKING_ALLOW_MONTHLY_TO_DAILY=true \\
   BOOKING_MONTH_TO_DAY_DIVISOR=30 \\
   BOOKING_DRAFT_TTL_MINUTES=15 \\
   BOOKING_PENDING_TTL_MINUTES=30 \\
   npx tsx src/main.ts

 TERMINAL 2 — web (listens on 127.0.0.1:3000):

   cd '$WEB'
   NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4000 \\
   npx next start -p 3000

 Then open http://127.0.0.1:3000/ar in Chrome / Firefox.

 Login flow — real OTP, printed by the console SMS adapter:
   1. On /ar/owner/login (or /ar/admin/login) enter the phone.
   2. Watch TERMINAL 1 for a line like
        [sms:console] +9665… ← SakanHub verification code: 123456
      That is the ONLY place the code appears; nothing writes it
      to disk. In production this adapter is REFUSED to boot by
      assertProdSafety in src/config.ts.
   3. Enter the 6 digits on the UI.

 Payments — sandbox provider only:
   PAYMENT_PROVIDER=sandbox is explicitly refused in production by
   assertProdSafety. The booking → review sheet → ادفع button runs
   through the dev-only /v1/dev/sandbox/capture route; no card data,
   no Moyasar network traffic, no real money.

 Stop:
   Ctrl-C both terminals. Delete $DATA to reset state.

EOF
