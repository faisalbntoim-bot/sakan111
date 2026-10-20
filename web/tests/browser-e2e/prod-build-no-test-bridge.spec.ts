/**
 * Guards that the test-only hook and window bridge are ABSENT from a
 * production Next build. The runner (`run.sh`) builds the project
 * twice — once WITHOUT `NEXT_PUBLIC_SAKAN_E2E` and saves the chunks to
 * `.next-prod-check/static/chunks`, then once WITH the flag for the
 * live e2e server. This spec greps the chunk JS to prove the test
 * symbol was eliminated at build time.
 *
 * A static grep is a stronger signal than a runtime window probe: it
 * proves the symbol is literally not shipped, not merely that the
 * module did not attach it on this one page load.
 */

import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from '@playwright/test';

const PROD_DIR = process.env.SAKAN_PROD_NEXT_DIR || path.join(__dirname, '..', '..', '.next-prod-check');

test.describe('production build has no e2e test bridge', () => {
  test('static chunks contain no reference to __sakanPendingCaptureTestBridge', async () => {
    const chunksDir = path.join(PROD_DIR, 'static', 'chunks');
    expect(fs.existsSync(chunksDir), `expected prod build at ${chunksDir}`).toBe(true);
    const files: string[] = [];
    function walk(d: string) {
      for (const name of fs.readdirSync(d)) {
        const p = path.join(d, name);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p);
        else if (name.endsWith('.js')) files.push(p);
      }
    }
    walk(chunksDir);
    expect(files.length, 'expected at least one js chunk').toBeGreaterThan(0);
    const hits: Array<{ file: string }> = [];
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      if (content.includes('__sakanPendingCaptureTestBridge')) hits.push({ file: f });
    }
    expect(hits, 'production bundle must not contain the test bridge symbol').toEqual([]);
  });
});
