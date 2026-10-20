/**
 * SMS provider abstraction.
 *
 * The OTP service does not import any specific vendor. It calls
 * `getSmsProvider().sendOtp({...})`. The selector in `./index.ts`
 * returns:
 *
 *   - `null` provider when SMS_PROVIDER is unset or set to 'null' —
 *     every call rejects with SmsNotConfiguredError so the OTP route
 *     answers the client with a clear "service unavailable" and we
 *     never claim a code was delivered when it was not.
 *
 *   - `console` provider when SMS_PROVIDER=console AND NODE_ENV is
 *     NOT production — writes the code to stdout for local dev / E2E
 *     tests. `assertProdSafety` in config.ts refuses to boot when
 *     production is combined with `null` or `console`.
 *
 *   - A real vendor adapter (unifonic / twilio / taqnyat / mesagat /
 *     sinch) once the operator picks one. All adapters implement this
 *     interface and are wired behind the same selector so switching
 *     vendors is one env var away.
 */

export interface SmsSendInput {
  /** E.164 phone, e.g. +9665XXXXXXXX. */
  to: string;
  /** Fully-formed message body in the recipient's locale. */
  message: string;
}

export interface SmsProvider {
  /** Vendor identifier (shown in logs / health checks; never a secret). */
  readonly name: string;
  /** Reject with `SmsNotConfiguredError` when the backing vendor is
   *  not usable. Reject with any `Error` subclass for transport
   *  failures. On success resolves to void. */
  sendOtp(input: SmsSendInput): Promise<void>;
}

/** Thrown when the OTP route reaches an SMS provider that cannot
 *  deliver (unset in prod, misconfigured, etc). Surfaced to callers
 *  as HTTP 503 — never as 500 — so the client knows the code was NOT
 *  sent and can retry later. */
export class SmsNotConfiguredError extends Error {
  readonly code = 'SMS_NOT_CONFIGURED' as const;
  readonly httpStatus = 503 as const;
  constructor(message = 'SMS provider is not configured') {
    super(message);
    this.name = 'SmsNotConfiguredError';
  }
}

/** Thrown for transient transport issues with a vendor that IS
 *  configured. Retryable at the client side; the route surfaces 503
 *  with a generic message so callers do not learn the vendor's status
 *  codes. */
export class SmsSendError extends Error {
  readonly code = 'SMS_SEND_FAILED' as const;
  readonly httpStatus = 503 as const;
  constructor(message = 'SMS delivery failed') {
    super(message);
    this.name = 'SmsSendError';
  }
}
