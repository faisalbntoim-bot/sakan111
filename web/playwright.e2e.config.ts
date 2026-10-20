import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for the REAL-BACKEND end-to-end test
 * (tests/browser-e2e/*). This is separate from the fast mocked
 * homepage-feed suite (playwright.config.ts) because it needs a backend
 * + Next.js running on known ports — the orchestration lives in
 * tests/browser-e2e/run.sh.
 */
export default defineConfig({
  testDir: './tests/browser-e2e',
  timeout: 120_000,
  reporter: [['list']],
  // Journey + guest-consent specs share a single seeded owner +
  // property and both mutate IndexedDB / backend state. Running them
  // in parallel on 2 workers makes journey trip over the guest's IDB
  // writes. Serial execution matches how a reviewer would run them.
  workers: 1,
  fullyParallel: false,
  use: {
    headless: true,
    launchOptions: { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
