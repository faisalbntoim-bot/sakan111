/**
 * "null" SMS provider — the safe default when no vendor is configured.
 *
 * Every call rejects. The OTP route catches the rejection, rolls back
 * (never creates the challenge row) and answers the client with 503.
 * We NEVER log the code anywhere when this provider is active, so a
 * production log scrape cannot leak OTPs.
 */

import { SmsNotConfiguredError, type SmsProvider, type SmsSendInput } from './provider.js';

export class NullSmsProvider implements SmsProvider {
  readonly name = 'null';
  async sendOtp(_input: SmsSendInput): Promise<void> {
    throw new SmsNotConfiguredError(
      'SMS provider is not configured. Set SMS_PROVIDER to a real vendor (e.g. unifonic) and provide its credentials.',
    );
  }
}
