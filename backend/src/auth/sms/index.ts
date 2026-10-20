/**
 * SMS provider selector.
 *
 * Picked once per process from `SMS_PROVIDER` env (`null` by default
 * so a misconfigured deployment fails loudly instead of silently
 * dropping OTPs). Adding a new vendor is one `case` + an adapter file.
 *
 * To swap vendors on a running host: set the env, restart the service.
 * No code change needed.
 */

import { config } from '../../config.js';
import { NullSmsProvider } from './null.js';
import { ConsoleSmsProvider } from './console.js';
import type { SmsProvider } from './provider.js';

let cached: SmsProvider | null = null;

export function getSmsProvider(): SmsProvider {
  if (cached) return cached;
  switch (config.SMS_PROVIDER) {
    case 'console':
      cached = new ConsoleSmsProvider();
      break;
    case 'null':
    default:
      cached = new NullSmsProvider();
      break;
    // NEW VENDORS GO HERE — one case per adapter, each file at
    // ./unifonic.ts, ./twilio.ts, etc. Keep the switch exhaustive so
    // config.ts can list the enum values operators are allowed to set.
  }
  return cached;
}

/** Test / DI hook — never used in production. */
export function _setSmsProvider(p: SmsProvider | null): void { cached = p; }
export { SmsNotConfiguredError, SmsSendError } from './provider.js';
export type { SmsProvider, SmsSendInput } from './provider.js';
