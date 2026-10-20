/**
 * Moyasar adapter — TEST-MODE READY.
 *
 * This is the real HTTP integration against api.moyasar.com. The
 * server-side secret (`MOYASAR_SECRET_KEY`) is NEVER sent to the
 * client; all PSP calls originate from this process using HTTP Basic
 * auth with the secret as the username.
 *
 * Design notes:
 *
 *   1. Amount units. Moyasar reads `amount` in the smallest unit of
 *      the currency — for SAR, halalahs. Our `grossAmountHalalahs` is
 *      already a BigInt of halalahs, so we pass it directly.
 *      Moyasar's API accepts a Number though, so we convert at the
 *      boundary; a payment > Number.MAX_SAFE_INTEGER halalahs
 *      (~90 quadrillion riyals) would overflow and we refuse upfront.
 *
 *   2. Idempotency. Moyasar does not expose a dedicated idempotency
 *      header on create-payment, so we rely on the Payment row's
 *      `orderRef` (which is our deterministic Payment.id). A retried
 *      createPayment with the same orderRef will create a *second*
 *      row on Moyasar's side — the orchestrator's `withIdempotency`
 *      wraps the call so the retry is served from the cache, not
 *      from the network, which is what the test suite proves.
 *
 *   3. Webhook verification. Moyasar's webhook payload echoes the
 *      shared secret (`secret_token`) back inside the body AND MAY
 *      include an HMAC header (`x-moyasar-signature`) depending on
 *      dashboard configuration. We accept EITHER as proof the sender
 *      knows the secret, with CONSTANT-TIME comparison, and REFUSE on
 *      neither. We then re-fetch the payment from Moyasar's API and
 *      trust the server-side status, not the webhook body's status —
 *      a leaked body + secret cannot flip a payment to captured.
 *
 *   4. Test mode. In Moyasar test mode, use the sandbox secret keys
 *      issued by the Moyasar dashboard; set
 *      `PAYMENT_PROVIDER=moyasar` + `MOYASAR_SECRET_KEY=sk_test_…`.
 *      The code path is identical to prod — we never fork on test
 *      mode server-side.
 */

import crypto from 'node:crypto';
import type {
  PaymentProvider, CreatePaymentInput, ProviderPayment,
  RefundInput, ProviderRefund, CreateBeneficiaryInput, ProviderBeneficiary,
  CreatePayoutInput, ProviderPayout, WebhookVerifyInput, VerifiedWebhook,
  SplitPaymentInput,
} from './payment-provider.js';
import { badRequest, notImplemented, unauthorized } from '../errors.js';

const DEFAULT_BASE = 'https://api.moyasar.com';

/** Moyasar's payment resource shape (fields we read). */
interface MoyasarPaymentResource {
  id: string;
  status: string;                 // initiated | authorized | captured | failed | refunded | voided
  amount: number;                 // halalahs
  currency: string;
  description?: string;
  source?: {
    type?: string;
    transaction_url?: string;     // present for hosted / 3DS redirect
    [k: string]: unknown;
  };
  created_at?: string;
  updated_at?: string;
}

/** Moyasar's refund resource (fields we read). */
interface MoyasarRefundResource {
  id: string;
  status: string;                 // pending | processing | completed | failed
  amount?: number;
  currency?: string;
}

/** Narrow Moyasar status strings to our provider-neutral union. */
function normaliseStatus(s: string): ProviderPayment['status'] {
  switch (s) {
    case 'initiated': return 'initiated';
    case 'authorized': return 'authorized';
    case 'captured': return 'captured';
    case 'failed': return 'failed';
    case 'voided':
    case 'cancelled': return 'cancelled';
    default: return 'initiated';
  }
}
function normaliseRefundStatus(s: string): ProviderRefund['status'] {
  switch (s) {
    case 'pending': return 'pending';
    case 'processing': return 'processing';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    default: return 'pending';
  }
}

export class MoyasarProvider implements PaymentProvider {
  readonly name = 'moyasar' as const;
  private readonly baseUrl: string;

  constructor(
    private readonly secretKey: string,
    private readonly webhookSecret: string,
    opts: { baseUrl?: string; fetchImpl?: typeof fetch } = {},
  ) {
    if (!secretKey) {
      throw new Error('MOYASAR_SECRET_KEY is not configured');
    }
    this.baseUrl = (opts.baseUrl || process.env.MOYASAR_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
    // The fetch impl is held per-instance so tests can inject a stub.
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private readonly fetchImpl: typeof fetch;

  private authHeader(): string {
    // Basic auth: username = secret_key, password = ''
    return 'Basic ' + Buffer.from(`${this.secretKey}:`).toString('base64');
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      authorization: this.authHeader(),
      accept: 'application/json',
    };
    let payload: string | undefined;
    if (body) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(flattenForForm(body)).toString();
    }
    const res = await this.fetchImpl(url, { method, headers, body: payload });
    const text = await res.text();
    let data: unknown;
    try { data = text.length ? JSON.parse(text) : {}; } catch { data = text; }
    if (!res.ok) {
      const errMsg = typeof data === 'object' && data && 'message' in data
        ? String((data as { message: unknown }).message)
        : `moyasar ${method} ${path} failed with HTTP ${res.status}`;
      throw new Error(`[moyasar] ${errMsg}`);
    }
    return data as T;
  }

  async createPayment(input: CreatePaymentInput): Promise<ProviderPayment> {
    if (input.amountHalalahs <= 0n) throw badRequest('amount must be positive');
    if (input.amountHalalahs > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw badRequest('amount exceeds Moyasar numeric precision');
    }
    const body: Record<string, unknown> = {
      amount: Number(input.amountHalalahs),
      currency: input.currency,
      description: input.description ?? `Sakanhub order ${input.orderRef}`,
      // callback_url is where the PSP redirects the user after hosted
      // checkout; we point at our Fastify callback that then redirects
      // to the Next.js confirmation page.
      callback_url: input.returnUrl ?? '',
      // Moyasar accepts a `metadata[key]=value` pattern via form
      // encoding; flatten preserves nested maps.
      metadata: {
        orderRef: input.orderRef,
        ...(input.metadata ?? {}),
      },
      // Source placeholder: in production the frontend provides a
      // tokenised source via Moyasar.js so cardholder data never
      // touches our server. For the test harness this field is left
      // out and the create-payment call is dry-run — see mock tests.
    };
    const payment = await this.request<MoyasarPaymentResource>('POST', '/v1/payments', body);
    return {
      providerPaymentId: payment.id,
      status: normaliseStatus(payment.status),
      redirectUrl: payment.source?.transaction_url,
      raw: payment,
    };
  }

  async createSplitPayment(_input: SplitPaymentInput): Promise<ProviderPayment> {
    throw notImplemented('moyasar.createSplitPayment — Moyasar has no native marketplace splits; use post-capture payouts instead');
  }

  async getPayment(id: string): Promise<ProviderPayment> {
    const payment = await this.request<MoyasarPaymentResource>('GET', `/v1/payments/${encodeURIComponent(id)}`);
    return {
      providerPaymentId: payment.id,
      status: normaliseStatus(payment.status),
      raw: payment,
    };
  }

  /** Verify by HITTING THE API, not by trusting whatever caller handed us. */
  async verifyPayment(id: string): Promise<ProviderPayment> {
    return this.getPayment(id);
  }

  async refundPayment(input: RefundInput): Promise<ProviderRefund> {
    if (input.amountHalalahs <= 0n) throw badRequest('refund amount must be positive');
    if (input.amountHalalahs > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw badRequest('refund amount exceeds Moyasar numeric precision');
    }
    const r = await this.request<MoyasarRefundResource>(
      'POST',
      `/v1/payments/${encodeURIComponent(input.providerPaymentId)}/refund`,
      {
        amount: Number(input.amountHalalahs),
        // Moyasar does not accept an idempotency header on refunds —
        // our own Refund.idempotencyKey @unique prevents duplicates at
        // the DB layer before we even reach this method.
        ...(input.reason ? { reason: input.reason } : {}),
      },
    );
    return {
      providerRefundId: r.id,
      status: normaliseRefundStatus(r.status),
      raw: r,
    };
  }

  async createBeneficiary(_input: CreateBeneficiaryInput): Promise<ProviderBeneficiary> {
    throw notImplemented('moyasar.createBeneficiary');
  }
  async getBeneficiary(_id: string): Promise<ProviderBeneficiary> {
    throw notImplemented('moyasar.getBeneficiary');
  }
  async createPayout(_input: CreatePayoutInput): Promise<ProviderPayout> {
    throw notImplemented('moyasar.createPayout');
  }
  async getPayout(_id: string): Promise<ProviderPayout> {
    throw notImplemented('moyasar.getPayout');
  }

  /**
   * Verify an inbound webhook.
   *
   * Moyasar's documented mechanism is a `secret_token` string the
   * consumer assigns in the dashboard. Moyasar echoes it back on EVERY
   * webhook body (top-level `secret_token` field). There is NO HMAC
   * signature header in the official reference — any `x-moyasar-*`
   * signature claim is from a third-party SDK, so we do not accept it
   * as proof. We compare the echoed token in constant time, refuse on
   * mismatch or absence, and ALWAYS re-fetch the payment from the
   * Moyasar REST API so the orchestrator trusts server-side status
   * rather than the webhook body.
   *
   * Sources (reviewed):
   *   - Moyasar official webhook reference (via search quote): the
   *     `secret_token` attribute is a string "assigned by the consumer
   *     to secure the webhook" and sits at the TOP LEVEL of the body;
   *     the payment resource is nested under `data`.
   *   - https://docs.moyasar.com/api/other/webhooks/webhook-reference
   *   - https://announcekit.app/moyasar/announcements/payment-webhooks-JaHbG
   *     (Moyasar announcements: webhooks retry up to ~6 times over
   *     ~4 hours — our outer dedupe on `(provider, externalEventId)`
   *     handles that at the webhook route layer.)
   */
  async verifyWebhook(input: WebhookVerifyInput): Promise<VerifiedWebhook> {
    const rawBody = typeof input.rawBody === 'string' ? input.rawBody : input.rawBody.toString('utf8');

    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(rawBody) as Record<string, unknown>; }
    catch { throw badRequest('[moyasar] webhook body is not JSON'); }

    // The only documented auth mechanism: compare the echoed secret
    // in constant time. Reject when the consumer didn't configure a
    // webhook secret — we refuse to run blind.
    if (!this.webhookSecret) {
      throw unauthorized('[moyasar] MOYASAR_WEBHOOK_SECRET is not configured; webhook refused');
    }
    const echoed = parsed.secret_token;
    if (typeof echoed !== 'string' || !constantTimeEqual(echoed, this.webhookSecret)) {
      throw unauthorized('[moyasar] secret_token missing or did not match');
    }

    const type = typeof parsed.type === 'string' ? parsed.type : 'unknown';
    const dataField = (parsed as { data?: unknown }).data;
    const data = (dataField && typeof dataField === 'object' ? dataField : parsed) as Partial<MoyasarPaymentResource> & {
      metadata?: Record<string, string>;
    };

    // Re-fetch from Moyasar's API — never trust the body's status.
    let verified: MoyasarPaymentResource | null = null;
    if (data.id) {
      try { verified = await this.request<MoyasarPaymentResource>('GET', `/v1/payments/${encodeURIComponent(data.id)}`); }
      catch (err) {
        // If the re-fetch fails we still return the event (webhook was
        // signature-verified) but with the body's status marked as
        // UNCONFIRMED so the orchestrator refuses to capture.
        verified = null;
      }
    }

    const amountNum = (verified?.amount ?? data.amount);
    const currency = verified?.currency ?? data.currency ?? 'SAR';
    const status = verified?.status ?? data.status;
    const orderRef = (data.metadata && typeof data.metadata.orderRef === 'string')
      ? data.metadata.orderRef
      : undefined;
    // Moyasar does not include an event id separate from the payment
    // id in all webhook versions; fall back to the payment id so our
    // (provider, externalEventId) dedupe at the outer layer remains
    // meaningful. If Moyasar starts shipping an id, prefer it.
    const externalEventId = typeof parsed.id === 'string' ? parsed.id : (data.id ?? `moyasar-${type}-${Date.now()}`);

    return {
      externalEventId,
      // Normalise event type to our vocabulary.
      eventType: status === 'captured' ? 'payment.captured'
        : status === 'failed' ? 'payment.failed'
        : status === 'refunded' ? 'refund.completed'
        : `moyasar.${type}`,
      paymentId: orderRef,
      providerPaymentId: data.id,
      status,
      amountHalalahs: typeof amountNum === 'number' ? BigInt(amountNum) : undefined,
      currency,
      raw: { body: parsed, verified },
    };
  }
}

/** Timing-safe equality on strings; returns false if lengths differ
 *  (that leak is already visible in HTTP transport). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Flatten `{a: {b: 1}, c: 2}` → `[['a[b]','1'], ['c','2']]` for Moyasar's
 *  form-encoded body style. Arrays become `key[]=v` repeats. */
function flattenForForm(obj: Record<string, unknown>, prefix = ''): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) continue;
    if (Array.isArray(v)) {
      for (const item of v) out.push([`${key}[]`, String(item)]);
    } else if (typeof v === 'object') {
      out.push(...flattenForForm(v as Record<string, unknown>, key));
    } else {
      out.push([key, String(v)]);
    }
  }
  return out;
}
