/**
 * OTP service.
 *
 * - 6-digit numeric code, 5-minute TTL, max 5 verify attempts.
 * - Codes are stored ONLY as `sha256(salt + code)` — never the raw code.
 * - Per-phone rate limit: max 3 challenges in any rolling 10-minute window.
 * - SMS delivery is delegated to the SMS adapter (`src/auth/sms/`).
 *   The challenge row is persisted ONLY AFTER a successful send; a
 *   send failure returns 503 and the caller sees the real "code not
 *   delivered" state. We never claim an OTP was sent when it wasn't.
 * - The `console` dev adapter is the only path that writes the OTP to
 *   stdout, and `assertProdSafety` refuses to boot with it in prod,
 *   so production logs never carry an OTP.
 * - Constant-time comparison on verify. On mismatch, `attempts` increments;
 *   when it reaches `maxAttempts` the challenge is invalidated even before expiry.
 */

import crypto from 'node:crypto';
import { getPrisma } from '../db.js';
import { AppError, badRequest, conflict, unauthorized } from '../errors.js';
import { getSmsProvider, SmsNotConfiguredError, SmsSendError } from './sms/index.js';

const OTP_LENGTH = 6;
const OTP_TTL_SECONDS = 300;                       // 5 min
const MAX_ATTEMPTS = 5;
const MAX_REQUESTS_PER_WINDOW = 3;
const RATE_WINDOW_SECONDS = 600;                   // 10 min
/** Hard cap on requests per IP in the SAME rolling window.
 *  Higher than per-phone because an IP may legitimately host several
 *  users (NAT, office networks), but low enough to blunt a scripted
 *  attempt. */
const MAX_REQUESTS_PER_IP = 10;
/** Cool-down applied to a phone AFTER a provider failure. Prevents a
 *  dead vendor from being hammered and refuses the user a few more
 *  requests even though their DB counter is still clean (because the
 *  failed send did not create a row). */
const FAILURE_COOLDOWN_MS = 60_000;

/** Per-process concurrency and cool-down state. These structures are
 *  intentionally in-memory and NOT shared across backend replicas:
 *   - the Fastify @fastify/rate-limit module runs process-local too
 *     and is the first line of defence (200/min globally);
 *   - a multi-replica deployment should put a shared rate limiter
 *     (Redis + fixed-window or token-bucket) in FRONT of the API —
 *     documented in docs/STAGING_PREVIEW_CHECKLIST.md. In the current
 *     single-process deployment, these guards close the race between
 *     two concurrent requests on the same phone / IP without needing
 *     external infrastructure. */
const inFlightPhones = new Set<string>();
const failureCooldown = new Map<string, number>();          // phone → epoch ms the cool-down expires
const ipTimestamps  = new Map<string, number[]>();          // ip → epoch ms of recent accepted requests

export interface OtpRequestResult {
  requestId: string;
  expiresInSeconds: number;
}

function generateCode(): string {
  // Cryptographically-random 6-digit code; never Math.random.
  const buf = crypto.randomBytes(4);
  const n = buf.readUInt32BE(0) % 1_000_000;
  return n.toString().padStart(OTP_LENGTH, '0');
}

function hashCode(salt: string, code: string): string {
  return crypto.createHash('sha256').update(`${salt}:${code}`).digest('hex');
}

/** Delivers the OTP through the configured SMS adapter. Surfaces
 *  provider-specific errors with their original http status so the
 *  caller sees a truthful 503 (not a generic 500) when the message
 *  did not go out. */
async function sendOtpSms(phone: string, code: string): Promise<void> {
  const provider = getSmsProvider();
  // The adapter is the SOLE place authorised to emit the code. We do
  // not log it here — any production log scrape stays clean.
  await provider.sendOtp({
    to: phone,
    // Minimal, locale-neutral template. Vendors with branded senders
    // override via their own template id; this is the fallback.
    message: `SakanHub verification code: ${code}`,
  });
}

export interface RequestOtpMeta {
  /** Fastify's `req.ip`. Omitted in unit tests that bypass HTTP. */
  ip?: string;
}

export async function requestOtp(phone: string, meta: RequestOtpMeta = {}): Promise<OtpRequestResult> {
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw badRequest('invalid phone (E.164 required)');
  const prisma = getPrisma();
  const now = Date.now();

  // (1) Post-failure cool-down. A phone that just hit a provider
  //     failure cannot retry immediately — this stops a client from
  //     mashing the submit button while the vendor is down.
  const coolUntil = failureCooldown.get(phone);
  if (coolUntil && coolUntil > now) {
    throw conflict('too many OTP requests; try again later');
  }
  if (coolUntil && coolUntil <= now) failureCooldown.delete(phone);

  // (2) Concurrency guard — ONE in-flight send per phone. The
  //     check-and-set must happen in ONE synchronous tick (no `await`
  //     in between) so two requests arriving in the same microtask
  //     cannot both pass. Everything from here until the finally{}
  //     is serialised FOR THIS PHONE.
  if (inFlightPhones.has(phone)) {
    throw conflict('OTP request already in progress for this phone');
  }
  inFlightPhones.add(phone);

  try {
    // (3) IP window — in-memory sliding window keyed by req.ip. An IP
    //     bursting more than MAX_REQUESTS_PER_IP in RATE_WINDOW_SECONDS
    //     is refused with 429. We prune in-place, so the map doesn't
    //     grow unbounded.
    if (meta.ip) {
      const windowStart = now - RATE_WINDOW_SECONDS * 1000;
      const existing = ipTimestamps.get(meta.ip) ?? [];
      const kept = existing.filter((t) => t > windowStart);
      if (kept.length >= MAX_REQUESTS_PER_IP) {
        throw conflict('too many OTP requests from this address; try again later');
      }
      // Reserve the slot now — we release only on provider failure.
      kept.push(now);
      ipTimestamps.set(meta.ip, kept);
    }

    // (4) Per-phone DB window. Counts persisted (successful) challenges
    //     only; see note on (6) for why failures do NOT increment this.
    const since = new Date(now - RATE_WINDOW_SECONDS * 1000);
    const recent = await prisma.otpChallenge.count({ where: { phone, createdAt: { gte: since } } });
    if (recent >= MAX_REQUESTS_PER_WINDOW) {
      // Rolling back the IP slot we just reserved (this phone's over
      // quota, not the whole address).
      rollbackIpSlot(meta.ip, now);
      throw conflict('too many OTP requests; try again later');
    }

    // (5) Enter the SEND stage.
    const code = generateCode();
    const salt = crypto.randomBytes(16).toString('hex');
    const codeHash = hashCode(salt, code);
    const expiresAt = new Date(now + OTP_TTL_SECONDS * 1000);

    // (6) SEND, THEN PERSIST. On failure we never write the challenge
    //     and we add a cool-down so retries don't hammer a dead
    //     vendor. The user sees a truthful 503, not a success.
    try {
      await sendOtpSms(phone, code);
    } catch (e) {
      failureCooldown.set(phone, now + FAILURE_COOLDOWN_MS);
      rollbackIpSlot(meta.ip, now);
      if (e instanceof SmsNotConfiguredError || e instanceof SmsSendError) {
        throw new AppError(e.code, 'OTP delivery is unavailable; try again later.', e.httpStatus);
      }
      throw e;
    }

    const challenge = await prisma.otpChallenge.create({
      data: { phone, codeHash, salt, expiresAt, maxAttempts: MAX_ATTEMPTS },
    });

    return { requestId: challenge.id, expiresInSeconds: OTP_TTL_SECONDS };
  } finally {
    inFlightPhones.delete(phone);
  }
}

function rollbackIpSlot(ip: string | undefined, ts: number): void {
  if (!ip) return;
  const list = ipTimestamps.get(ip);
  if (!list) return;
  const i = list.lastIndexOf(ts);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) ipTimestamps.delete(ip);
}

/** Test-only — wipes the per-process guards so unit tests see a clean
 *  rate-limit state between cases. */
export function _resetOtpGuards(): void {
  inFlightPhones.clear();
  failureCooldown.clear();
  ipTimestamps.clear();
}

/** Verifies the presented code and returns the phone on success. Throws on any failure. */
export async function verifyOtp(input: { requestId: string; code: string; phone: string }): Promise<{ phone: string }> {
  const prisma = getPrisma();
  const challenge = await prisma.otpChallenge.findUnique({ where: { id: input.requestId } });
  if (!challenge) throw unauthorized('invalid request');
  if (challenge.phone !== input.phone) throw unauthorized('invalid request');
  if (challenge.consumedAt) throw unauthorized('code already used');
  if (challenge.expiresAt.getTime() < Date.now()) throw unauthorized('code expired');
  if (challenge.attempts >= challenge.maxAttempts) throw unauthorized('too many attempts');

  const expected = hashCode(challenge.salt, input.code);
  const ok = crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(challenge.codeHash, 'hex'));
  if (!ok) {
    await prisma.otpChallenge.update({
      where: { id: challenge.id },
      data: { attempts: { increment: 1 } },
    });
    throw unauthorized('invalid code');
  }

  await prisma.otpChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date() },
  });
  return { phone: challenge.phone };
}
