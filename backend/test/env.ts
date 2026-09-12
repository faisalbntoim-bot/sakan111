/**
 * Runs once per test worker BEFORE modules are imported.
 * Keeps the test DB isolated from the dev DB.
 *
 * Path safety: Prisma resolves `file:` URLs relative to the schema
 * directory (`backend/prisma/`), NOT the Node CWD. If the caller
 * supplied a URL that already includes `prisma/…`, Prisma would
 * happily create a nested `backend/prisma/prisma/…` copy. We detect
 * that case and normalise the path so vitest can never produce a
 * stray nested DB file. The canonical location is
 * `backend/prisma/test.db`.
 */

import { resolve } from 'node:path';

process.env.NODE_ENV = 'test';

function normaliseSqliteUrl(rawUrl: string | undefined): string {
  const url = rawUrl && rawUrl.length > 0 ? rawUrl : 'file:./test.db';
  if (!url.startsWith('file:')) return url; // postgres/mysql — leave alone
  const rest = url.slice('file:'.length);
  // Absolute path — trust the caller.
  if (rest.startsWith('/')) return url;
  // If the relative path starts with "prisma/" or "./prisma/", drop the
  // leading segment: schema-relative resolution would nest it.
  const stripped = rest.replace(/^\.\//, '').replace(/^prisma\//, '');
  // Force to schema-relative (Prisma default): keep as file:./<file>
  return 'file:./' + stripped;
}

process.env.DATABASE_URL = normaliseSqliteUrl(process.env.DATABASE_URL);
process.env.PAYMENT_PROVIDER = 'sandbox';
process.env.MONEY_ROUNDING = process.env.MONEY_ROUNDING || 'banker';
process.env.DEFAULT_PLATFORM_FEE_PERCENT = process.env.DEFAULT_PLATFORM_FEE_PERCENT || '5';
process.env.DEFAULT_TAX_RATE_PERCENT = process.env.DEFAULT_TAX_RATE_PERCENT || '15';

// Convenience for tests that log the resolved absolute path.
export const RESOLVED_TEST_DB_ABS = process.env.DATABASE_URL.startsWith('file:')
  ? resolve(process.cwd(), 'prisma', process.env.DATABASE_URL.replace(/^file:\.\//, '').replace(/^file:/, ''))
  : null;
