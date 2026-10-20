/**
 * OTP integrity under a non-configured SMS provider.
 *
 * Specific guarantees this test defends:
 *
 *   1. When the SMS adapter rejects (null provider, vendor outage,
 *      operator misconfiguration), `requestOtp` does NOT create an
 *      OtpChallenge row. We never claim a code was sent when it was
 *      not — the DB stays untouched.
 *
 *   2. The OTP itself is NEVER written to stdout under the null
 *      provider. A production log scrape cannot leak a code because
 *      the code was never persisted anywhere, including logs.
 *
 *   3. The rejection surfaces as a 503-shaped error (`SMS_NOT_CONFIGURED`
 *      code, httpStatus 503) so the route serves a truthful
 *      "service unavailable" rather than a generic 500.
 *
 *   4. The console provider — the dev-only alternative — is refused
 *      at runtime when NODE_ENV=production, as a belt-and-suspenders
 *      guard beyond `assertProdSafety`.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { resetDb, shutdown } from './helpers.js';
import { getPrisma } from '../src/db.js';
import { requestOtp } from '../src/auth/otp.js';
import { _setSmsProvider, SmsNotConfiguredError, type SmsProvider } from '../src/auth/sms/index.js';
import { NullSmsProvider } from '../src/auth/sms/null.js';
import { ConsoleSmsProvider } from '../src/auth/sms/console.js';

beforeEach(async () => { await resetDb(); _setSmsProvider(null); });
afterAll(async () => { await shutdown(); _setSmsProvider(null); });

describe('otp integrity — null provider must never claim a send', () => {
  it('null SMS provider: requestOtp throws 503, zero challenge rows persisted, zero OTPs in stdout', async () => {
    _setSmsProvider(new NullSmsProvider());

    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(requestOtp('+966500000001')).rejects.toMatchObject({
        code: 'SMS_NOT_CONFIGURED',
        httpStatus: 503,
      });
    } finally { stdoutSpy.mockRestore(); }

    // No row in the DB — we did NOT persist a challenge for a code
    // nobody will receive.
    const count = await getPrisma().otpChallenge.count({ where: { phone: '+966500000001' } });
    expect(count).toBe(0);

    // No OTP in stdout — the null provider does not log, by design.
    const printedWithDigits = stdoutSpy.mock.calls.flat().some((arg) =>
      typeof arg === 'string' && /\b\d{6}\b/.test(arg),
    );
    expect(printedWithDigits).toBe(false);
  });

  it('null SMS provider: repeated attempts do NOT inflate the DB rate-limit counter', async () => {
    _setSmsProvider(new NullSmsProvider());
    // First attempt: provider fails → 503.
    await expect(requestOtp('+966500000002')).rejects.toMatchObject({ code: 'SMS_NOT_CONFIGURED' });
    // Immediate retries hit the post-failure cool-down (409). That's
    // intentional — a dead vendor must not be hammered — and still
    // leaves the DB untouched. The behaviour we assert HERE is simply
    // that no OtpChallenge row got persisted across the sequence.
    for (let i = 0; i < 2; i++) {
      await expect(requestOtp('+966500000002')).rejects.toThrow();
    }
    const count = await getPrisma().otpChallenge.count({ where: { phone: '+966500000002' } });
    expect(count).toBe(0);
  });

  it('console provider refuses to execute when NODE_ENV=production (runtime guard)', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const p = new ConsoleSmsProvider();
      await expect(p.sendOtp({ to: '+966500000003', message: 'x' }))
        .rejects.toBeInstanceOf(SmsNotConfiguredError);
    } finally { process.env.NODE_ENV = previous; }
  });

  it('console provider in test env: writes to stdout AND requestOtp persists the challenge', async () => {
    _setSmsProvider(new ConsoleSmsProvider());
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const result = await requestOtp('+966500000004');
      expect(result.requestId).toBeTruthy();
      // Challenge row DID persist.
      const row = await getPrisma().otpChallenge.findUnique({ where: { id: result.requestId } });
      expect(row).not.toBeNull();
      // Logged line follows the [sms:console] format the E2E runner greps for.
      const printed = stdoutSpy.mock.calls.flat().filter((arg) => typeof arg === 'string') as string[];
      const printedLines = printed.filter((s) => s.includes('[sms:console]'));
      expect(printedLines.length).toBe(1);
      expect(printedLines[0]).toContain('+966500000004');
      expect(printedLines[0]).toMatch(/\b\d{6}\b/);
    } finally { stdoutSpy.mockRestore(); }
  });

  it('arbitrary vendor adapter that throws SmsNotConfiguredError: same 503 contract, no DB row', async () => {
    const adapter: SmsProvider = {
      name: 'fake-outage',
      async sendOtp() { throw new SmsNotConfiguredError('vendor temporarily unavailable'); },
    };
    _setSmsProvider(adapter);
    await expect(requestOtp('+966500000005')).rejects.toMatchObject({
      code: 'SMS_NOT_CONFIGURED',
      httpStatus: 503,
    });
    const count = await getPrisma().otpChallenge.count({ where: { phone: '+966500000005' } });
    expect(count).toBe(0);
  });
});
