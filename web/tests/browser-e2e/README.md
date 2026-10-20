# Browser-level end-to-end test — against a REAL backend

This folder holds a Playwright test that drives a real Chromium against a
real Fastify backend talking to a real SQLite file. **It does not mock
the API** and **it does not change advertisementLifecycle directly in
the DB** — every transition flows through an HTTP endpoint.

## What it does

1. Spins up:
   - Backend on `127.0.0.1:4101` with a fresh SQLite DB.
   - Next.js on `127.0.0.1:3101`, built with
     `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4101`.
2. Seeds one owner + one admin + one DRAFT property (direct Prisma for
   this seed step only — this is fixture setup, not lifecycle testing).
3. Mints real HS256 JWTs for owner + admin against the same JWT_SECRET
   the backend uses.
4. Playwright:
   - Owner session cookie seeded into `sessionStorage` via `addInitScript`.
   - Navigate `/ar/owner/properties`.
   - Upload the fixture video `tests/fixtures/tiny.mp4` via the hidden
     `<input type="file">` for the album picker (no camera needed —
     the keyboard path is identical).
   - Verify the finalize succeeded (asset renders in gallery).
   - Toggle its showcase to public via the new checkbox.
   - Submit for review via `POST /v1/properties/:id/submit` (owner).
   - Admin: `POST /v1/admin/properties/:id/mark-verified` then publish.
   - Navigate `/ar` — verify the real listing appears with a working
     video chip whose `<video src>` is a signed URL (no Bearer).

## What it does NOT do

- No `getUserMedia` / `MediaRecorder` — hardware camera flow stays as a
  separate manual-test item (see §5 of REVIEW-V7).
- No shortcut past admin review — the test drives the admin API with a
  real admin JWT, not a DB `UPDATE`.

## How to run (local)

```sh
cd web
bash tests/browser-e2e/run.sh
```

The script sets up state, runs the test, and tears down. On any failure
it prints the saved logs and exits non-zero.
