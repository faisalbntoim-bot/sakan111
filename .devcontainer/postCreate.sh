#!/usr/bin/env bash
# .devcontainer/postCreate.sh — ONE-TIME build for the SakanHub preview.
#
# This script runs ONLY on the Codespace's first boot (and whenever the
# container is rebuilt). It does not run on normal stop/start cycles —
# that is postStart.sh's job.
#
# What this script does, in strict order:
#   1. Install deps (npm ci) in backend/ and web/.
#   2. Generate 32-byte random JWT + media-signing secrets with Node's
#      crypto.randomBytes() and store them under preview-data/.secrets.env
#      (gitignored; nothing leaves this Codespace).
#   3. Create an isolated SQLite DB under preview-data/preview.db and
#      run `prisma db push --skip-generate` against it. No real DB is
#      touched. --accept-data-loss is deliberately NOT passed, so if the
#      file already carried a schema we would refuse to clobber it.
#   4. Seed owner / admin / customer with explicit Role rows plus one
#      PUBLISHED property. Login still uses the real OTP flow.
#   5. Compute the Codespace's public port-3000 URL from $CODESPACE_NAME
#      and $GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN, and build the Next
#      app with:
#        NEXT_PUBLIC_API_BASE_URL = that public URL
#        SAKAN_PREVIEW_PROXY      = 1   (turns on /v1/* → 127.0.0.1:4000)
#        NEXT_PUBLIC_SAKAN_E2E    = true (unlocks sandbox-pay button)
#
# Non-goals (explicit):
#   - No push, no commit, no deploy.
#   - No real payment, real refund, real SMS — PAYMENT_PROVIDER=sandbox
#     and SMS_PROVIDER=console at runtime, both of which are refused
#     under NODE_ENV=production by src/config.ts and src/auth/sms/console.ts.
#   - No change to any config outside preview-data/ or the two app folders.
#   - Nothing in this script would make a prod boot easier if copied —
#     the baked NEXT_PUBLIC_SAKAN_E2E flag makes the .next output a
#     PREVIEW artifact. Do NOT ship web/.next from this Codespace.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DATA="$ROOT/preview-data"
LOGS="$DATA/logs"
MEDIA="$DATA/media"
DB="$DATA/preview.db"
SECRETS="$DATA/.secrets.env"
BACKEND="$ROOT/backend"
WEB="$ROOT/web"

mkdir -p "$DATA" "$LOGS" "$MEDIA"

echo "[postCreate] installing backend deps…"
(cd "$BACKEND" && npm ci --no-audit --no-fund)

echo "[postCreate] installing web deps…"
(cd "$WEB" && npm ci --no-audit --no-fund)

# ----- 1) secrets (local, gitignored) -----------------------------------
if [ ! -f "$SECRETS" ]; then
  echo "[postCreate] generating local secrets → $SECRETS"
  JWT=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  SIGN=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  cat > "$SECRETS" <<EOF
# AUTO-GENERATED LOCAL PREVIEW SECRETS. Never leaves this Codespace.
# Delete and rerun .devcontainer/postCreate.sh to rotate.
export SAKAN_JWT_SECRET="$JWT"
export SAKAN_MEDIA_UPLOAD_SIGNING_SECRET="$SIGN"
EOF
  chmod 600 "$SECRETS"
else
  echo "[postCreate] reusing existing secrets at $SECRETS"
fi
# shellcheck disable=SC1090
. "$SECRETS"
[ "${#SAKAN_JWT_SECRET}" -ge 32 ] || { echo "secret too short, delete $SECRETS and rerun"; exit 1; }

# ----- 2) isolated DB + prisma push -------------------------------------
if [ ! -s "$DB" ]; then
  : > "$DB"
  echo "[postCreate] created fresh preview DB at $DB"
else
  echo "[postCreate] reusing existing preview DB at $DB"
fi
DBURL="file:$DB"

echo "[postCreate] prisma db push against $DBURL (no --accept-data-loss)"
(cd "$BACKEND" && DATABASE_URL="$DBURL" npx prisma db push --skip-generate)

# ----- 3) seed owner / admin / customer ---------------------------------
echo "[postCreate] seeding owner + admin + customer…"
(cd "$BACKEND" && DATABASE_URL="$DBURL" npx tsx scripts/seed-preview.ts) || {
  echo "[postCreate] seed failed; see output above"; exit 1;
}

# ----- 4) compute the Codespace public URL ------------------------------
if [ -n "${CODESPACE_NAME:-}" ] && [ -n "${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN:-}" ]; then
  PUBLIC_URL="https://${CODESPACE_NAME}-3000.${GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN}"
  echo "[postCreate] Codespace public URL: $PUBLIC_URL"
else
  PUBLIC_URL="http://localhost:3000"
  echo "[postCreate] WARNING — Codespace env not detected; building with $PUBLIC_URL."
fi

# Persist the computed URL + DB path for postStart (and for the operator
# to see) under preview-data/preview.env — this file is also gitignored.
cat > "$DATA/preview.env" <<EOF
# AUTO-GENERATED on postCreate. Do not commit. Rewritten on each rebuild.
export SAKAN_PREVIEW_PUBLIC_URL="$PUBLIC_URL"
export SAKAN_PREVIEW_DB_URL="$DBURL"
export SAKAN_PREVIEW_MEDIA_DIR="$MEDIA"
EOF

# ----- 5) build the Next.js app (PREVIEW artifact) ----------------------
echo "[postCreate] building Next.js with preview flags…"
(
  cd "$WEB"
  NEXT_PUBLIC_API_BASE_URL="$PUBLIC_URL" \
  SAKAN_PREVIEW_PROXY=1 \
  NEXT_PUBLIC_SAKAN_E2E=true \
  npm run build
)

echo ""
echo "============================================================"
echo " postCreate finished."
echo " Preview URL (private, only you can open it signed in):"
echo "   $PUBLIC_URL"
echo " Backend logs will be at:   $LOGS/backend.log"
echo " Web logs will be at:       $LOGS/web.log"
echo "============================================================"
