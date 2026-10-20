/**
 * Moyasar adapter tests (test mode, no real network).
 *
 * MOCKED-FETCH DISCLAIMER: these tests prove the request/response
 * SHAPE our code produces and consumes. They DO NOT prove that
 * Moyasar's live API accepts them. A real test-mode run — hitting
 * api.moyasar.com with sk_test_… keys against a seeded dashboard
 * webhook — is a separate deliverable (see MOYASAR_TEST_MODE.md).
 *
 * Covers (mocked):
 *  - createPayment posts the correct form fields with amount in
 *    halalahs and HTTP Basic auth with the secret key.
 *  - verifyPayment hits GET /v1/payments/:id.
 *  - verifyWebhook accepts the DOCUMENTED echoed `secret_token`,
 *    refuses when it's missing, refuses when it's wrong, and ALWAYS
 *    re-fetches the payment resource from the Moyasar API (so the
 *    orchestrator trusts the server-side status, not the body).
 *  - amount / currency guard: our `capturePayment` already rejects
 *    a webhook whose reported amount disagrees with the Payment row;
 *    this test proves the Moyasar adapter FORWARDS the server-side
 *    amount faithfully so that guard runs on real data.
 *  - refundPayment posts correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { MoyasarProvider } from '../src/providers/moyasar.js';

type Call = { url: string; method: string; headers: Record<string, string>; body: string | null };
type Scripted = { status: number; body: unknown };

function fakeFetch(script: Scripted[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : (url as URL).toString();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const bodyStr = init?.body ? String(init.body) : null;
    calls.push({ url: urlStr, method: init?.method ?? 'GET', headers, body: bodyStr });
    const next = script.shift();
    if (!next) throw new Error(`[test] unexpected fetch: ${init?.method} ${urlStr}`);
    const payload = typeof next.body === 'string' ? next.body : JSON.stringify(next.body);
    return new Response(payload, { status: next.status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const SECRET = 'sk_test_moyasar_secret_123';
const WEBHOOK_SECRET = 'wh_test_secret_abcdef';

describe('MoyasarProvider — createPayment', () => {
  it('posts to /v1/payments with amount in halalahs, basic auth, and metadata.orderRef', async () => {
    const { impl, calls } = fakeFetch([{
      status: 200,
      body: {
        id: 'pay_abc', status: 'initiated', amount: 95175, currency: 'SAR',
        source: { type: 'creditcard', transaction_url: 'https://api.moyasar.com/v1/payments/pay_abc/redirect' },
      },
    }]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { baseUrl: 'https://api.moyasar.com', fetchImpl: impl });
    const r = await p.createPayment({
      amountHalalahs: 95175n,
      currency: 'SAR',
      orderRef: 'pay-cuid-123',
      description: 'Sakanhub test booking',
      returnUrl: 'https://sakanhubb.com/ar/bookings/x',
      metadata: { bookingId: 'book-abc' },
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.moyasar.com/v1/payments');
    expect(calls[0]!.headers['authorization']).toBe(
      'Basic ' + Buffer.from('sk_test_moyasar_secret_123:').toString('base64'),
    );
    // Form-encoded body contains amount, currency, metadata[orderRef], metadata[bookingId].
    const body = decodeURIComponent(calls[0]!.body!);
    expect(body).toContain('amount=95175');
    expect(body).toContain('currency=SAR');
    expect(body).toContain('metadata[orderRef]=pay-cuid-123');
    expect(body).toContain('metadata[bookingId]=book-abc');
    expect(r.providerPaymentId).toBe('pay_abc');
    expect(r.status).toBe('initiated');
    expect(r.redirectUrl).toContain('/v1/payments/pay_abc/redirect');
  });

  it('refuses an amount that overflows Number precision', async () => {
    const { impl } = fakeFetch([]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { fetchImpl: impl });
    await expect(p.createPayment({
      amountHalalahs: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      currency: 'SAR',
      orderRef: 'x',
    })).rejects.toThrow(/exceeds Moyasar numeric precision/);
  });

  it('surfaces Moyasar API errors (not a silent 200)', async () => {
    const { impl } = fakeFetch([{ status: 400, body: { message: 'amount is too small' } }]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { baseUrl: 'https://api.moyasar.com', fetchImpl: impl });
    await expect(p.createPayment({
      amountHalalahs: 10n, currency: 'SAR', orderRef: 'x',
    })).rejects.toThrow(/amount is too small/);
  });
});

describe('MoyasarProvider — verifyWebhook (official secret_token)', () => {
  const payment = { id: 'pay_abc', status: 'captured', amount: 95175, currency: 'SAR', metadata: { orderRef: 'book-abc' } };

  it('verifies the documented echoed secret_token and re-fetches the payment before returning', async () => {
    const body = JSON.stringify({ type: 'payment_paid', secret_token: WEBHOOK_SECRET, data: payment });
    const { impl, calls } = fakeFetch([{ status: 200, body: payment }]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { baseUrl: 'https://api.moyasar.com', fetchImpl: impl });
    const v = await p.verifyWebhook({ rawBody: body, headers: {} });
    // The adapter hit the re-fetch endpoint.
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.url).toBe('https://api.moyasar.com/v1/payments/pay_abc');
    // Returned event is normalised and carries the amount in halalahs.
    expect(v.eventType).toBe('payment.captured');
    expect(v.providerPaymentId).toBe('pay_abc');
    expect(v.amountHalalahs).toBe(95175n);
    expect(v.currency).toBe('SAR');
    expect(v.paymentId).toBe('book-abc');
  });

  it('refuses when secret_token is missing (no fallback — nothing undocumented is honoured)', async () => {
    const body = JSON.stringify({ type: 'payment_paid', data: payment });
    const { impl, calls } = fakeFetch([]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { fetchImpl: impl });
    await expect(p.verifyWebhook({ rawBody: body, headers: {} })).rejects.toThrow(/secret_token/);
    // Zero outbound fetches — a bogus webhook never touches Moyasar.
    expect(calls.length).toBe(0);
  });

  it('refuses when secret_token is wrong (constant-time compare, no fetch)', async () => {
    const body = JSON.stringify({ type: 'payment_paid', secret_token: 'WRONG', data: payment });
    const { impl, calls } = fakeFetch([]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { fetchImpl: impl });
    await expect(p.verifyWebhook({ rawBody: body, headers: {} })).rejects.toThrow(/secret_token/);
    expect(calls.length).toBe(0);
  });

  it('refuses when webhookSecret is empty (operator misconfiguration — never auto-accept)', async () => {
    const body = JSON.stringify({ type: 'payment_paid', secret_token: '', data: payment });
    const { impl } = fakeFetch([]);
    const p = new MoyasarProvider(SECRET, '', { fetchImpl: impl });
    await expect(p.verifyWebhook({ rawBody: body, headers: {} }))
      .rejects.toThrow(/WEBHOOK_SECRET is not configured/);
  });

  it('does NOT trust the body status when the re-fetch disagrees (uses the server-side payment)', async () => {
    // Body claims captured, but Moyasar's API says failed. The returned
    // event mirrors Moyasar, not the body.
    const bodyPayment = { id: 'pay_abc', status: 'captured', amount: 95175, currency: 'SAR', metadata: { orderRef: 'book-abc' } };
    const serverPayment = { id: 'pay_abc', status: 'failed',   amount: 95175, currency: 'SAR', metadata: { orderRef: 'book-abc' } };
    const body = JSON.stringify({ type: 'payment_paid', secret_token: WEBHOOK_SECRET, data: bodyPayment });
    const { impl } = fakeFetch([{ status: 200, body: serverPayment }]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { fetchImpl: impl });
    const v = await p.verifyWebhook({ rawBody: body, headers: {} });
    expect(v.status).toBe('failed');
    expect(v.eventType).toBe('payment.failed');
  });

  it('forwards the re-fetched amountHalalahs so the orchestrator can run the amount/currency guard', async () => {
    // The webhook body claims 10 halalahs, Moyasar API says 95175.
    // The adapter must forward 95175 so capturePayment's
    // `reportedAmountHalalahs !== payment.grossAmountHalalahs` guard
    // kicks in on the TRUE amount, not the attacker's.
    const bodyPayment = { id: 'pay_abc', status: 'captured', amount: 10, currency: 'SAR', metadata: { orderRef: 'book-abc' } };
    const serverPayment = { id: 'pay_abc', status: 'captured', amount: 95175, currency: 'SAR', metadata: { orderRef: 'book-abc' } };
    const body = JSON.stringify({ type: 'payment_paid', secret_token: WEBHOOK_SECRET, data: bodyPayment });
    const { impl } = fakeFetch([{ status: 200, body: serverPayment }]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { fetchImpl: impl });
    const v = await p.verifyWebhook({ rawBody: body, headers: {} });
    expect(v.amountHalalahs).toBe(95175n);
  });
});

describe('MoyasarProvider — refundPayment', () => {
  it('posts to /v1/payments/:id/refund with amount in halalahs', async () => {
    const { impl, calls } = fakeFetch([{
      status: 200, body: { id: 'ref_1', status: 'completed', amount: 90000, currency: 'SAR' },
    }]);
    const p = new MoyasarProvider(SECRET, WEBHOOK_SECRET, { baseUrl: 'https://api.moyasar.com', fetchImpl: impl });
    const r = await p.refundPayment({
      providerPaymentId: 'pay_abc',
      amountHalalahs: 90000n,
      reason: 'customer-request',
      idempotencyKey: 'idem-ref-1',
    });
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.moyasar.com/v1/payments/pay_abc/refund');
    const body = decodeURIComponent(calls[0]!.body!);
    expect(body).toContain('amount=90000');
    expect(body).toContain('reason=customer-request');
    expect(r.providerRefundId).toBe('ref_1');
    expect(r.status).toBe('completed');
  });
});
