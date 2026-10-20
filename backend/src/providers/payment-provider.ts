/**
 * Payment Provider abstraction.
 *
 * All PSP integrations (Sandbox, Moyasar, Tap, ...) implement this interface.
 * The Financial Engine only ever depends on this interface — never on a
 * concrete SDK — so we can swap providers without touching business logic.
 *
 * SECRETS ARE SERVER-SIDE ONLY. The mobile/web clients never see them.
 */

import { config } from '../config.js';

export type ProviderName = 'sandbox' | 'moyasar' | 'tap';

export interface CreatePaymentInput {
  amountHalalahs: bigint;
  currency: string;                          // 'SAR'
  orderRef: string;                          // opaque; usually payment.id
  description?: string;
  customer?: { name?: string; email?: string; phone?: string };
  // For split/marketplace models later:
  destinations?: { beneficiaryId: string; amountHalalahs: bigint }[];
  metadata?: Record<string, string>;
  returnUrl?: string;
}

export interface ProviderPayment {
  providerPaymentId: string;
  status: 'initiated' | 'authorized' | 'captured' | 'failed' | 'cancelled';
  redirectUrl?: string;                       // for 3DS or hosted checkout
  raw?: unknown;
}

export interface SplitPaymentInput {
  amountHalalahs: bigint;
  currency: string;
  orderRef: string;
  destinations: { beneficiaryId: string; amountHalalahs: bigint }[];
  description?: string;
  customer?: { name?: string; email?: string; phone?: string };
  returnUrl?: string;
  metadata?: Record<string, string>;
}

export interface RefundInput {
  providerPaymentId: string;
  amountHalalahs: bigint;
  reason?: string;
  idempotencyKey: string;
}

export interface ProviderRefund {
  providerRefundId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  raw?: unknown;
}

export interface CreateBeneficiaryInput {
  name: string;
  iban: string;                               // provider will validate & mask
  countryCode: string;                        // 'SA'
  bankName?: string;
}

export interface ProviderBeneficiary {
  providerBeneficiaryId: string;
  status: 'pending' | 'active' | 'rejected';
  ibanMasked?: string;
  raw?: unknown;
}

export interface CreatePayoutInput {
  beneficiaryId: string;                      // provider's id
  amountHalalahs: bigint;
  currency: string;
  reference: string;
  idempotencyKey: string;
}

export interface ProviderPayout {
  providerPayoutId: string;
  status: 'scheduled' | 'processing' | 'paid' | 'failed';
  raw?: unknown;
}

export interface WebhookVerifyInput {
  rawBody: Buffer | string;
  headers: Record<string, string | undefined>;
}

export interface VerifiedWebhook {
  externalEventId: string;
  eventType: string;                          // 'payment.captured', 'refund.completed', ...
  paymentId?: string;                         // orderRef we sent, if present
  providerPaymentId?: string;
  status?: string;
  amountHalalahs?: bigint;
  currency?: string;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: ProviderName;

  createPayment(input: CreatePaymentInput): Promise<ProviderPayment>;
  /** Marketplace split-payment. Not every provider supports it — see the stubs. */
  createSplitPayment(input: SplitPaymentInput): Promise<ProviderPayment>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  verifyPayment(providerPaymentId: string): Promise<ProviderPayment>;
  refundPayment(input: RefundInput): Promise<ProviderRefund>;

  createBeneficiary(input: CreateBeneficiaryInput): Promise<ProviderBeneficiary>;
  getBeneficiary(id: string): Promise<ProviderBeneficiary>;
  createPayout(input: CreatePayoutInput): Promise<ProviderPayout>;
  getPayout(id: string): Promise<ProviderPayout>;

  verifyWebhook(input: WebhookVerifyInput): Promise<VerifiedWebhook>;
}

// ---------------- Factory ----------------

let cached: PaymentProvider | null = null;

export async function getProvider(): Promise<PaymentProvider> {
  if (cached) return cached;
  switch (config.PAYMENT_PROVIDER) {
    case 'sandbox': {
      const { SandboxProvider } = await import('./sandbox.js');
      cached = new SandboxProvider(); break;
    }
    case 'moyasar': {
      // Real HTTP integration (test and prod).
      const { MoyasarProvider } = await import('./moyasar.js');
      cached = new MoyasarProvider(config.MOYASAR_SECRET_KEY, config.MOYASAR_WEBHOOK_SECRET); break;
    }
    case 'tap': {
      const { TapProvider } = await import('./tap.stub.js');
      cached = new TapProvider(config.TAP_SECRET_KEY, config.TAP_WEBHOOK_SECRET); break;
    }
  }
  return cached!;
}

/** Test/DI hook. */
export function _setProvider(p: PaymentProvider | null) { cached = p; }
