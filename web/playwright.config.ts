import { defineConfig, devices } from '@playwright/test';

/**
 * Minimal Playwright config for the browser-level journey test.
 *
 * - Uses the Chromium that ships with the preview sandbox at
 *   /opt/pw-browsers/chromium-1194. We never run `playwright install`.
 * - Starts the Next.js production server once per run (built ahead by
 *   `npm run build`), bound to port 3100 so it doesn't collide with
 *   the owner's dev server on 3000.
 * - Points at a locally running backend on port 4000 — set
 *   SAKAN_API_BASE at test invocation time.
 *
 * This config is intentionally scoped: it covers the end-user journey
 * on /ar (publishable feed, demo-pool suppression, lifecycle gating).
 * Backend behavior is covered by vitest in backend/test/*.
 */
export default defineConfig({
  testDir: './tests/browser',
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.SAKAN_WEB_BASE || 'http://127.0.0.1:3100',
    headless: true,
    launchOptions: {
      executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
