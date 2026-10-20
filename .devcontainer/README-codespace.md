# SakanHub Codespace Preview (private, sandbox-only)

This folder turns the `preview/sakanhub-staging` branch into a **private,
isolated preview** inside a GitHub Codespace. The preview is reachable
over real HTTPS so Safari on an iPhone can open it, upload image + video,
play them back, book a property and run a sandbox payment — without any
file leaving the Codespace and without touching production.

## What runs where

| Component | Port | Visibility |
|-----------|------|------------|
| Next.js (`web/`) — SakanDesign SPA + API client | 3000 | **public URL, private visibility** (only you, signed into github.com, can open it) |
| Fastify (`backend/`) — Prisma + Moyasar sandbox + console SMS | 4000 | **127.0.0.1 only**, never forwarded |
| SQLite preview DB | `preview-data/preview.db` | inside Codespace only |
| Uploaded media | `preview-data/media/` | inside Codespace only |

The browser sees **one HTTPS origin**: Next.js rewrites every `/v1/*`
(REST + `/v1/media/local-stream/*` video reads) to `127.0.0.1:4000` on
the server side, so there is no CORS traffic and no second public URL.

## How to open the preview

1. On github.com → `faisalbntoim-bot/airpnp1`, switch to the
   `preview/sakanhub-staging` branch.
2. **Code → Codespaces → Create codespace on preview/sakanhub-staging**.
   The first boot runs `postCreate.sh` (installs deps, generates local
   secrets, seeds owner/admin/customer, builds Next.js with the
   Codespace public URL baked in). This takes **~3–5 minutes**.
3. When the terminal appears, `postStart.sh` has already launched the
   backend (127.0.0.1:4000) and the web (public port 3000). The last
   log line prints the public URL, which looks like
   `https://<codespace-name>-3000.app.github.dev`.
4. Open that URL in Safari on your iPhone. GitHub will ask you to sign
   in once because the port visibility is **private** — nobody else can
   reach the URL, even if they get it.
5. For OTP, open the Codespace's **Terminal → Panel → `tail -f
   preview-data/logs/backend.log`** and watch for a line like
   `[sms:console] +9660001000 ← SakanHub verification code: 123456`.
   This is the only place a code is written; it is never persisted.

## Test accounts (role is seeded, NOT inferred from phone)

| Role     | Phone          | Login page           | What they can do |
|----------|----------------|----------------------|------------------|
| OWNER    | `+9660001000`  | `/ar/owner/login`    | Edit the seeded property, upload image + video, submit for review |
| ADMIN    | `+9660003000`  | `/ar/admin/login`    | Publish properties, read orphan payments |
| CUSTOMER | `+9660002000`  | any `/ar/*` page     | Book + pay (sandbox only) |
| any other phone | — | any `/ar/*` page | logs in as the DEFAULT CUSTOMER role |

Logging in with a new phone **does NOT** grant admin or owner by
itself — those roles come from `Role` rows seeded by
`backend/scripts/seed-preview.ts`.

## What is sandbox / preview-only

- `PAYMENT_PROVIDER=sandbox` — no Moyasar network traffic, no card data.
  The pay button runs `/v1/dev/sandbox/capture` (dev-only route).
  Production refuses to boot with this provider via `assertProdSafety`.
- `SMS_PROVIDER=console` — the OTP is printed to the backend log and
  never written anywhere else. Production refuses to boot this provider
  via `assertProdSafety` AND a runtime guard in `src/auth/sms/console.ts`.
- `NEXT_PUBLIC_SAKAN_E2E=true` is baked into the Next.js build so the
  pay button accepts the sandbox-capture fallback instead of refusing on
  `NO_GATEWAY`. **Do NOT upload this `.next/` folder anywhere.** The
  backend's `assertProdSafety` would still refuse to boot in production,
  but defence in depth — treat the whole `web/.next` as unshippable.

## Stopping the preview

- From the Codespace **Code tab → Codespaces → … → Stop**. The
  container shuts down; the DB and media files remain in
  `preview-data/`. On the next start, `postStart.sh` re-launches both
  services and reuses them.
- To fully reset, open a terminal in the Codespace and run
  `rm -rf preview-data`, then **Codespace → Rebuild Container**. New
  secrets, empty DB, no media.
- To destroy the Codespace entirely: github.com → **Codespaces**
  (sidebar on your profile) → `…` → **Delete**. The container, its
  disk, and the port forward are gone.

## What is NOT in this preview

- No commit, push, deploy, or production edit happens from inside the
  Codespace.
- No real SMS vendor is configured.
- No real payment provider is configured (sandbox only).
- No DNS change, no change to the production site at `sakanhubb.com`,
  no change to the production DB.

## Billing

Codespaces hours are billed to your personal GitHub account. The
preview uses the smallest machine (2-core). **Stop the Codespace** when
you are done with the preview so you are not charged for idle time.
