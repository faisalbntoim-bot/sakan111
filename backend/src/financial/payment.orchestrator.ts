/**
 * Payment Orchestrator — the single choreographer for the full flow:
 *
 *   book → quote → provider create → (webhook: verify + capture) → ledger → settlement → invoice
 *
 * Never trust the client for "paid". Only a verified webhook (or a signed
 * server-side verifyPayment call) may transition a payment to `captured`.
 */

import { getPrisma } from '../db.js';
import { getProvider } from '../providers/payment-provider.js';
import { computeQuote, type Quote } from './pricing.js';
import type { TransactionType } from './commission.js';
import { postCaptureEntries } from './ledger.js';
import { audit } from '../audit.js';
import { withIdempotency } from '../idempotency.js';
import { conflict, notFound, badRequest } from '../errors.js';
import { createInvoiceForPayment } from './invoice.js';
import { createSettlementsForCapture } from './settlement.js';
import { config } from '../config.js';

export interface StartCheckoutInput {
  bookingId: string;
  idempotencyKey: string;
  customer?: { name?: string; email?: string; phone?: string };
  returnUrl?: string;
}

export interface StartCheckoutResult {
  paymentId: string;
  providerPaymentId: string;
  redirectUrl?: string;
  quote: Quote;
}

export async function startCheckout(input: StartCheckoutInput): Promise<StartCheckoutResult> {
  return withIdempotency({ key: input.idempotencyKey, scope: 'startCheckout', requestBody: { bookingId: input.bookingId } }, async () => {
    const prisma = getPrisma();
    const booking = await prisma.booking.findUnique({ where: { id: input.bookingId }, include: { property: true } });
    if (!booking) throw notFound('booking not found');
    if (booking.status !== 'draft' && booking.status !== 'pending_payment') {
      throw conflict(`booking is ${booking.status}, cannot start checkout`);
    }

    const quote = await computeQuote({
      transactionType: booking.transactionType as TransactionType,
      propertyType: booking.property.category,
      grossAmountHalalahs: booking.grossAmountHalalahs,
      currency: booking.currency,
    });

    const provider = await getProvider();

    // Create a Payment row FIRST (deterministic id we pass to the provider as orderRef).
    const payment = await prisma.payment.create({
      data: {
        bookingId: booking.id,
        type: 'CHARGE',
        grossAmountHalalahs: quote.customerTotalHalalahs,
        currency: booking.currency,
        status: 'pending',
        provider: provider.name,
        idempotencyKey: input.idempotencyKey,
        metadata: JSON.stringify({ quote: serialiseQuote(quote) }),
      },
    });

    const providerPayment = await provider.createPayment({
      amountHalalahs: quote.customerTotalHalalahs,
      currency: booking.currency,
      orderRef: payment.id,
      description: `Booking ${booking.id} (${booking.transactionType})`,
      customer: input.customer,
      returnUrl: input.returnUrl,
      metadata: { bookingId: booking.id, transactionType: booking.transactionType },
    });

    await prisma.payment.update({
      where: { id: payment.id },
      data: { providerPaymentId: providerPayment.providerPaymentId, providerStatus: providerPayment.status },
    });

    await prisma.booking.update({ where: { id: booking.id }, data: { status: 'pending_payment' } });

    await audit({ action: 'PAYMENT.CREATED', entity: 'Payment', entityId: payment.id });

    return {
      paymentId: payment.id,
      providerPaymentId: providerPayment.providerPaymentId,
      redirectUrl: providerPayment.redirectUrl,
      quote,
    };
  });
}

/**
 * Capture a payment based on a verified webhook (or a verified server-side check).
 * Idempotent: safe to call twice; only the first call posts ledger + creates invoice.
 */
export async function capturePayment(args: {
  paymentId: string;
  providerPaymentId: string;
  gatewayFeeHalalahs?: bigint;
  /** Optional: the amount the PSP says it captured. If provided, must match our row exactly. */
  reportedAmountHalalahs?: bigint;
  /** Optional: the currency the PSP reports. If provided, must match our row exactly. */
  reportedCurrency?: string;
}): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { id: args.paymentId }, include: { booking: { include: { property: true } } } });
    if (!payment) throw notFound(`payment ${args.paymentId} not found`);
    // Idempotent terminal states: a second webhook arriving on an
    // already-captured OR already-orphaned payment is a replay. Return
    // without touching the row, without emitting another PaymentEvent,
    // and without a second audit entry. The webhook route dedupes by
    // (provider, externalEventId) at an outer layer; this is the
    // last-ditch guard in case the dedupe table was wiped or a
    // different webhook payload resurrects an old providerPaymentId.
    if (payment.status === 'captured') return;
    if (payment.status === 'captured_orphan') return;
    if (payment.status !== 'pending') throw conflict(`payment in status ${payment.status}, cannot capture`);
    if (payment.providerPaymentId !== args.providerPaymentId) throw badRequest('provider payment id mismatch');
    // Amount + currency verification — never trust the webhook body blindly.
    if (args.reportedAmountHalalahs != null && args.reportedAmountHalalahs !== payment.grossAmountHalalahs) {
      throw badRequest(`webhook amount ${args.reportedAmountHalalahs} does not match payment ${payment.grossAmountHalalahs}`);
    }
    if (args.reportedCurrency != null && args.reportedCurrency !== payment.currency) {
      throw badRequest(`webhook currency ${args.reportedCurrency} does not match payment ${payment.currency}`);
    }
    if (!payment.bookingId) {
      throw badRequest('payment has no booking; cannot capture in this flow');
    }

    // Late-payment guard. The booking-expiry worker may have cancelled
    // the booking (draft or pending_payment past TTL) between
    // startCheckout and the webhook's arrival. We mark the payment
    // orphaned instead of flipping the booking back to confirmed —
    // the operator reconciles via refund. Without this guard a late
    // webhook could resurrect a booking whose dates have been reused
    // by a new customer, creating a silent double-booking.
    if (payment.booking && payment.booking.status === 'cancelled') {
      await tx.payment.update({
        where: { id: args.paymentId },
        data: {
          status: 'captured_orphan',
          capturedAt: new Date(),
          providerStatus: 'captured',
          // Carry the gross forward literally — this is the amount the
          // PSP successfully charged, which is what the operator must
          // refund (or clear via admin review).
          grossAmountHalalahs: payment.grossAmountHalalahs,
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentId: args.paymentId,
          kind: 'captured_orphan',
          data: JSON.stringify({
            reason: 'booking_already_cancelled',
            bookingId: payment.booking.id,
            amountHalalahs: payment.grossAmountHalalahs.toString(),
            currency: payment.currency,
            refundPath: 'admin-review',
          }),
        },
      });
      return;
    }

    const gatewayFee = args.gatewayFeeHalalahs ?? 0n;
    await tx.payment.update({
      where: { id: args.paymentId },
      data: { status: 'captured', capturedAt: new Date(), gatewayFeeHalalahs: gatewayFee, providerStatus: 'captured' },
    });
    await tx.paymentEvent.create({ data: { paymentId: args.paymentId, kind: 'captured', data: JSON.stringify({ gatewayFee: gatewayFee.toString() }) } });

    // Confirm the booking ONLY if it is still eligible. A booking in
    // 'cancelled' would be caught by the guard above; anything else
    // (draft, pending_payment) is normal.
    if (payment.booking && payment.booking.status !== 'confirmed') {
      await tx.booking.update({
        where: { id: payment.booking.id },
        data: { status: 'confirmed', confirmedAt: new Date() },
      });
    }
  });

  // Outside the tx: post ledger, create settlement + invoice. We only
  // run this for the normal captured path — a `captured_orphan` row
  // represents money that reached us against a cancelled booking; the
  // operator refunds via a separate flow and the ledger stays clean.
  const payment = await getPrisma().payment.findUnique({ where: { id: args.paymentId }, include: { booking: { include: { property: true } } } });
  if (!payment?.booking) return;
  if (payment.status === 'captured_orphan') {
    // Audit the orphan transition only ONCE per payment. We detect
    // "first transition" by the absence of any PAYMENT.CAPTURED_ORPHAN
    // row in the audit log — the row we're about to write. A replay
    // (second webhook) sees the existing row and short-circuits so
    // operator alerts and refund workflows aren't double-fired.
    const existing = await getPrisma().auditLog.findFirst({
      where: { entity: 'Payment', entityId: payment.id, action: 'PAYMENT.CAPTURED_ORPHAN' },
      select: { id: true },
    });
    if (!existing) {
      await audit({
        action: 'PAYMENT.CAPTURED_ORPHAN',
        entity: 'Payment',
        entityId: payment.id,
        after: {
          bookingId: payment.booking.id,
          amountHalalahs: payment.grossAmountHalalahs.toString(),
          currency: payment.currency,
          providerPaymentId: payment.providerPaymentId,
          refundPath: 'admin-review',
        },
      });
    }
    return;
  }
  if (payment.status !== 'captured') return;

  const quoteFromMetadata = payment.metadata ? deserialiseQuote(JSON.parse(payment.metadata).quote) : null;
  if (!quoteFromMetadata) return;

  await postCaptureEntries({
    paymentId: payment.id,
    bookingId: payment.booking.id,
    quote: quoteFromMetadata,
    gatewayFeeHalalahs: args.gatewayFeeHalalahs ?? 0n,
    hostUserId: payment.booking.hostId ?? null,
    ownerUserId: payment.booking.property.ownerId,
    officeId: payment.booking.officeId ?? null,
    marketerId: payment.booking.marketerId ?? null,
  });

  await createSettlementsForCapture({
    paymentId: payment.id,
    hostUserId: payment.booking.hostId ?? null,
    ownerUserId: payment.booking.property.ownerId,
    officeId: payment.booking.officeId ?? null,
    marketerId: payment.booking.marketerId ?? null,
    quote: quoteFromMetadata,
    currency: payment.currency,
  });

  await createInvoiceForPayment({ paymentId: payment.id });

  await audit({ action: 'PAYMENT.CAPTURED', entity: 'Payment', entityId: payment.id });
}

// ---------------- Quote serialisation (BigInt-safe) ----------------

export function serialiseQuote(q: Quote): unknown {
  return JSON.parse(JSON.stringify(q, (_, v) => typeof v === 'bigint' ? { __bi: v.toString() } : v));
}
function deserialiseQuote(v: unknown): Quote {
  const s = JSON.stringify(v);
  return JSON.parse(s, (_k, val) => (val && typeof val === 'object' && '__bi' in val) ? BigInt((val as { __bi: string }).__bi) : val) as Quote;
}
