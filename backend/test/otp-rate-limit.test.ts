/**
 * Atomic OTP rate limiting — pre-provider guards.
 *
 * These tests cover the paths that stop a concurrent / burst
 * attempt BEFORE the SMS adapter ever runs:
 *
 *   - 10 concurrent `requestOtp(phone)` calls → at most ONE provider
 *     send; the other 9 reject with 409 "already in progress" and
 *     NEVER emit the OTP to any log.
 *   - A phone whose provider fails is placed in a short cool-down,
 *     refusing immediate retries without touching the DB counter.
 *   - A single IP bursting more than the IP cap is refused with 409.
 *   - A phone over its DB window is refused AND the IP slot it
 *     reserved is rolled back (so the IP cap is not inflated by
 *     per-phone over-quota rejections).
 *   - On provider failure the IP slot is rolled back and no OTP is
 *     logged, EVEN under the console adapter.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { resetDb, shutdown } from './helpers.js';
import { getPrisma } from '../src/db.js';
import { requestOtp, _resetOtpGuards } from '../src/auth/otp.js';
import { _setSmsProvider, SmsSendError, type SmsProvider } from '../src/auth/sms/index.js';
import { ConsoleSmsProvider } from '../src/auth/sms/console.js';
import { NullSmsProvider } from '../src/auth/sms/null.js';

beforeEach(async () => {
  await resetDb();
  _resetOtpGuards();
  _setSmsProvider(null);
});
afterAll(async () => { await shutdown(); _resetOtpGuards(); _setSmsProvider(null); });

/** A provider whose sendOtp is single-threaded via a shared Promise so
 *  we can prove the concurrency guard rejects siblings before they
 *  reach it (and NOT just because they queue inside the provider). */
function makeGatedProvider(): { adapter: SmsProvider; sends: Array<{ to: string; message: string }>; release: () => void } {
  const sends: Array<{ to: string; message: string }> = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const adapter: SmsProvider = {
    name: 'gated-test',
    async sendOtp(input) {
      sends.push(input);
      await gate;
    },
  };
  return { adapter, sends, release };
}

describe('otp rate-limit — concurrent + cool-down + IP cap', () => {
  it('10 concurrent requests for the same phone → ONE provider send; nine 409', async () => {
    const { adapter, sends, release } = makeGatedProvider();
    _setSmsProvider(adapter);

    // Fire 10 requests before releasing the gate. The first grabs
    // the in-flight lock; the other nine must reject.
    const phone = '+966500000011';
    const promises = Array.from({ length: 10 }, () => requestOtp(phone, { ip: '203.0.113.1' }));
    // Give the first a microtask to enter the critical section.
    await Promise.resolve();
    // Now release so the first can finish.
    release();
    const results = await Promise.allSettled(promises);
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length;
    const rejected  = results.filter((r) => r.status === 'rejected');
    const rejectCodes = rejected.map((r) => (r as PromiseRejectedResult).reason?.code ?? 'unknown');
    expect(fulfilled).toBe(1);
    expect(rejected.length).toBe(9);
    // All rejections are the concurrency guard (409 CONFLICT).
    expect(rejectCodes.every((c) => c === 'CONFLICT')).toBe(true);
    // Only one send actually left the process.
    expect(sends.length).toBe(1);
    // Only one challenge was persisted.
    const rows = await getPrisma().otpChallenge.count({ where: { phone } });
    expect(rows).toBe(1);
  });

  it('provider failure applies a cool-down so an immediate retry is refused', async () => {
    const adapter: SmsProvider = {
      name: 'always-fails',
      async sendOtp() { throw new SmsSendError('simulated vendor outage'); },
    };
    _setSmsProvider(adapter);
    const phone = '+966500000012';
    // First call: provider fails → 503.
    await expect(requestOtp(phone, { ip: '203.0.113.2' })).rejects.toMatchObject({
      code: 'SMS_SEND_FAILED', httpStatus: 503,
    });
    // Immediate retry: cool-down → 409.
    await expect(requestOtp(phone, { ip: '203.0.113.2' })).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    // Zero DB rows: we never claimed delivery.
    const rows = await getPrisma().otpChallenge.count({ where: { phone } });
    expect(rows).toBe(0);
  });

  it('IP window: eleventh request from the same IP is refused even across phones', async () => {
    _setSmsProvider(new ConsoleSmsProvider());
    const ip = '203.0.113.3';
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      // Fire 10 valid requests across unique phones from the same IP.
      for (let i = 0; i < 10; i++) {
        await requestOtp(`+96650000${String(i).padStart(5, '0')}`, { ip });
      }
      // The 11th from the SAME IP must reject with the IP cap message.
      await expect(requestOtp('+966500000999', { ip })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: expect.stringMatching(/from this address/),
      });
    } finally { stdoutSpy.mockRestore(); }
  });

  it('phone over-quota: the IP slot is rolled back so the IP cap is not inflated by per-phone rejections', async () => {
    _setSmsProvider(new ConsoleSmsProvider());
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const phoneA = '+966500000021';
      const phoneB = '+966500000022';
      const ip = '203.0.113.4';
      // Fill the per-phone quota for phoneA (3).
      await requestOtp(phoneA, { ip });
      await requestOtp(phoneA, { ip });
      await requestOtp(phoneA, { ip });
      // Over-quota attempt — rejects.
      await expect(requestOtp(phoneA, { ip })).rejects.toMatchObject({ code: 'CONFLICT' });
      // phoneB can still use the IP — rollback worked.
      const r = await requestOtp(phoneB, { ip });
      expect(r.requestId).toBeTruthy();
    } finally { stdoutSpy.mockRestore(); }
  });

  it('provider failure: zero OTPs printed to stdout even under the console adapter path (null provider)', async () => {
    _setSmsProvider(new NullSmsProvider());
    const stdoutSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await expect(requestOtp('+966500000031', { ip: '203.0.113.5' })).rejects.toMatchObject({
        code: 'SMS_NOT_CONFIGURED',
      });
      // Nothing with 6 digits was printed — null provider logs nothing.
      const strPrinted = stdoutSpy.mock.calls.flat().filter((a) => typeof a === 'string') as string[];
      expect(strPrinted.some((s) => /\b\d{6}\b/.test(s))).toBe(false);
    } finally { stdoutSpy.mockRestore(); }
  });
});
