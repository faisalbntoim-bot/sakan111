/**
 * "console" SMS provider — DEV AND TEST ONLY.
 *
 * Writes the OTP to stdout so a developer or the E2E runner can
 * complete the login flow. `config.ts:assertProdSafety` refuses to
 * boot the app when NODE_ENV=production and SMS_PROVIDER=console, so
 * this file CANNOT execute in production. If somebody tries to swap
 * NODE_ENV=production at runtime after boot (`process.env.NODE_ENV`
 * mutation) we still refuse to print — the second check below is
 * belt-and-suspenders against that scenario.
 */

import { SmsNotConfiguredError, type SmsProvider, type SmsSendInput } from './provider.js';

export class ConsoleSmsProvider implements SmsProvider {
  readonly name = 'console';
  async sendOtp(input: SmsSendInput): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new SmsNotConfiguredError(
        'SMS_PROVIDER=console is not permitted in production. Configure a real vendor.',
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[sms:console] ${input.to} ← ${input.message}`);
  }
}
