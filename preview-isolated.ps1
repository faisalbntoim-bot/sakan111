# preview-isolated.ps1 — Windows preview for the unified Next 15 build.
#
# This script prepares a PREVIEW-ONLY artifact. It is not a production
# bundle and MUST NOT be deployed:
#
#   1. The Next.js app is built with `NEXT_PUBLIC_SAKAN_E2E=true`, which
#      bakes two feature flags into the client bundle at COMPILE time:
#        - ALLOW_LOCAL_FIXTURE=true   (lets the pay button run the
#                                      sandbox-capture fallback instead
#                                      of refusing on `NO_GATEWAY`)
#        - sandbox "simulate failure" button becomes visible
#      These flags live in a bundle that would not refuse to serve if
#      copied to a production host. The backend's `assertProdSafety`
#      still refuses to boot with PAYMENT_PROVIDER=sandbox, so a
#      misdirected deploy fails CLOSED at the server; but to be safe
#      do NOT upload the ./web/.next produced by this script anywhere.
#
#   2. The backend runs in NODE_ENV=development with:
#        - PAYMENT_PROVIDER=sandbox   (refused in prod by config)
#        - SMS_PROVIDER=console       (refused in prod by config AND
#                                      by a runtime guard in
#                                      src/auth/sms/console.ts)
#        - STORAGE_PROVIDER=local     (writes under preview-data/media)
#        - Isolated SQLite at preview-data\preview.db
#
#   3. Secrets are generated locally with Windows crypto RNG. They
#      never leave this machine and are stored in preview-data\.secrets.ps1
#      with the file ACL inherited from preview-data\ (keep this folder
#      out of version control; the repo .gitignore already excludes it).
#
# What it does NOT do: no commit, no push, no deploy, no production
# database or SSL changes.
#
# To run (from this folder):
#     powershell -ExecutionPolicy Bypass -File .\preview-isolated.ps1
#
# To stop: Ctrl-C both of the two terminals the script prints at the
# end. Delete .\preview-data\ to reset the DB and media.

$ErrorActionPreference = 'Stop'

function Assert-Command($name) {
    if (-not (Get-Command $name -ErrorAction SilentlyContinue)) {
        Write-Error "Required command '$name' is not on PATH. Install Node.js 22+ from https://nodejs.org and reopen PowerShell."
    }
}

function New-RandomSecret {
    # 32 bytes → base64url (43 chars, URL-safe).
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

Assert-Command node
Assert-Command npm
Assert-Command npx

$Root       = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }
$DataDir    = Join-Path $Root 'preview-data'
$MediaDir   = Join-Path $DataDir 'media'
$DbPath     = Join-Path $DataDir 'preview.db'
$SecretsPs1 = Join-Path $DataDir '.secrets.ps1'
$BackendDir = Join-Path $Root 'backend'
$WebDir     = Join-Path $Root 'web'

if (-not (Test-Path $BackendDir) -or -not (Test-Path $WebDir)) {
    Write-Error "Expected 'backend' and 'web' folders alongside this script. Current root: $Root"
}

New-Item -ItemType Directory -Force -Path $DataDir  | Out-Null
New-Item -ItemType Directory -Force -Path $MediaDir | Out-Null

# ---- 1) Local secrets ---------------------------------------------------
if (-not (Test-Path $SecretsPs1)) {
    Write-Host "[preview] generating local secrets at $SecretsPs1"
    $jwt  = New-RandomSecret
    $sign = New-RandomSecret
    @"
# AUTO-GENERATED LOCAL PREVIEW SECRETS. Do NOT commit this file.
# Delete and rerun preview-isolated.ps1 to rotate them.
`$env:SAKAN_JWT_SECRET = "$jwt"
`$env:SAKAN_MEDIA_UPLOAD_SIGNING_SECRET = "$sign"
"@ | Set-Content -Path $SecretsPs1 -Encoding UTF8
} else {
    Write-Host "[preview] reusing secrets from $SecretsPs1"
}
. $SecretsPs1
if (-not $env:SAKAN_JWT_SECRET -or $env:SAKAN_JWT_SECRET.Length -lt 32) {
    Write-Error "JWT secret missing or too short. Delete $SecretsPs1 and rerun."
}
if (-not $env:SAKAN_MEDIA_UPLOAD_SIGNING_SECRET -or $env:SAKAN_MEDIA_UPLOAD_SIGNING_SECRET.Length -lt 32) {
    Write-Error "Media upload signing secret missing or too short. Delete $SecretsPs1 and rerun."
}

# ---- 2) Isolated SQLite DB ---------------------------------------------
if (Test-Path $DbPath) {
    $sizeKB = [Math]::Round((Get-Item $DbPath).Length / 1KB, 1)
    Write-Host "[preview] DB already exists ($sizeKB KB) at $DbPath — reusing. Delete it manually to reset."
} else {
    Write-Host "[preview] creating fresh preview DB at $DbPath"
    New-Item -ItemType File -Force -Path $DbPath | Out-Null
}
$DatabaseUrl = "file:$($DbPath.Replace('\','/'))"

# ---- 3) Install deps (idempotent) --------------------------------------
if (-not (Test-Path (Join-Path $BackendDir 'node_modules'))) {
    Write-Host "[preview] installing backend deps (npm ci)…"
    Push-Location $BackendDir
    try { npm ci } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $WebDir 'node_modules'))) {
    Write-Host "[preview] installing web deps (npm ci)…"
    Push-Location $WebDir
    try { npm ci } finally { Pop-Location }
}

# ---- 4) prisma db push against the isolated DB -------------------------
Push-Location $BackendDir
try {
    $env:DATABASE_URL = $DatabaseUrl
    Write-Host "[preview] prisma db push → $DatabaseUrl (no --accept-data-loss)"
    npx prisma db push --skip-generate
} finally {
    Pop-Location
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
}

# ---- 5) Build Next.js (PREVIEW-ONLY artifact) --------------------------
Push-Location $WebDir
try {
    $env:NEXT_PUBLIC_API_BASE_URL = 'http://127.0.0.1:4000'
    # NEXT_PUBLIC_SAKAN_E2E=true bakes the preview flags into the
    # client bundle at build time. This is EXPLICIT so you can see it
    # in the build log; do NOT ship this .next folder anywhere.
    $env:NEXT_PUBLIC_SAKAN_E2E   = 'true'
    Write-Host "[preview] building Next.js (preview flags baked in) → check the output for '15.5' and 'Compiled successfully'"
    npm run build
} finally {
    Pop-Location
    Remove-Item Env:NEXT_PUBLIC_API_BASE_URL -ErrorAction SilentlyContinue
    Remove-Item Env:NEXT_PUBLIC_SAKAN_E2E    -ErrorAction SilentlyContinue
}

# ---- 6) Seed owner + admin + customer ---------------------------------
Push-Location $BackendDir
try {
    $env:DATABASE_URL = $DatabaseUrl
    Write-Host "[preview] seeding owner + admin + customer…"
    npx tsx scripts/seed-preview.ts
} finally {
    Pop-Location
    Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
}

# ---- 7) Print the two commands ----------------------------------------
Write-Host ""
Write-Host "============================================================"
Write-Host " Preview is ready. Open TWO new PowerShell windows:"
Write-Host "============================================================"
Write-Host ""
Write-Host " WINDOW 1 — backend (127.0.0.1:4000):"
Write-Host ""
Write-Host "   cd '$BackendDir'"
Write-Host "   . '$SecretsPs1'"
Write-Host "   `$env:PORT = '4000'"
Write-Host "   `$env:NODE_ENV = 'development'"
Write-Host "   `$env:JWT_SECRET = `$env:SAKAN_JWT_SECRET"
Write-Host "   `$env:JWT_ISSUER = 'sakanhub-backend'"
Write-Host "   `$env:DATABASE_URL = '$DatabaseUrl'"
Write-Host "   `$env:STORAGE_PROVIDER = 'local'"
Write-Host "   `$env:LOCAL_STORAGE_DIR = '$MediaDir'"
Write-Host "   `$env:MEDIA_UPLOAD_SIGNING_SECRET = `$env:SAKAN_MEDIA_UPLOAD_SIGNING_SECRET"
Write-Host "   `$env:CORS_ALLOWED_ORIGINS = 'http://127.0.0.1:3000,http://localhost:3000'"
Write-Host "   `$env:PAYMENT_PROVIDER = 'sandbox'"
Write-Host "   `$env:SMS_PROVIDER     = 'console'"
Write-Host "   `$env:BOOKING_ALLOW_MONTHLY_TO_DAILY = 'true'"
Write-Host "   `$env:BOOKING_MONTH_TO_DAY_DIVISOR   = '30'"
Write-Host "   `$env:BOOKING_DRAFT_TTL_MINUTES      = '15'"
Write-Host "   `$env:BOOKING_PENDING_TTL_MINUTES    = '30'"
Write-Host "   npx tsx src/main.ts"
Write-Host ""
Write-Host " WINDOW 2 — web (127.0.0.1:3000):"
Write-Host ""
Write-Host "   cd '$WebDir'"
Write-Host "   `$env:NEXT_PUBLIC_API_BASE_URL = 'http://127.0.0.1:4000'"
Write-Host "   npx next start -p 3000"
Write-Host ""
Write-Host " Open http://127.0.0.1:3000/ar in your browser on THIS Windows machine."
Write-Host ""
Write-Host " Preview accounts (role is NOT granted by phone alone — these are seeded):"
Write-Host "   OWNER     +9660001000  → /ar/owner/login  → edit property, upload media, submit"
Write-Host "   ADMIN     +9660003000  → /ar/admin/login  → publish, orphan-payment review"
Write-Host "   CUSTOMER  +9660002000  → any /ar/* page   → book + pay (sandbox)"
Write-Host "   Any other phone logs in as the default CUSTOMER."
Write-Host ""
Write-Host " iPhone over HTTPS (optional): see IPHONE-HTTPS-PREVIEW.md next to this script —"
Write-Host "   cloudflared tunnel --url http://127.0.0.1:3000  (and rebuild Window 2 with"
Write-Host "   NEXT_PUBLIC_API_BASE_URL set to the https://*.trycloudflare.com URL)."
Write-Host ""
