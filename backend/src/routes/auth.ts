/**
 * Auth routes.
 *
 *   POST /v1/auth/otp                 — request an OTP
 *   POST /v1/auth/otp/verify          — verify + get JWT pair (auto-signup by phone)
 *   POST /v1/auth/refresh             — rotate refresh token, issue new pair
 *   POST /v1/auth/logout              — revoke the presented refresh token
 *   GET  /v1/auth/me                  — introspect the current access token
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { getPrisma } from '../db.js';
import { requestOtp, verifyOtp } from '../auth/otp.js';
import { ACCESS_TTL_SECONDS, issueTokenPair, rotateRefreshToken, revokeRefreshToken, signAccessToken } from '../auth/jwt.js';
import { requireAuth, type Role } from '../auth/rbac.js';
import { audit } from '../audit.js';
import { badRequest, forbidden, notFound, unauthorized } from '../errors.js';
import { config } from '../config.js';

const requestSchema = z.object({ phone: z.string().min(6).max(20) });
const verifySchema = z.object({
  requestId: z.string().min(1),
  phone: z.string().min(6).max(20),
  code: z.string().regex(/^\d{6}$/, '6-digit code required'),
  nameAr: z.string().optional(),                        // for first-time signup
});
const refreshSchema = z.object({ refreshToken: z.string().min(10) });

export default async function authRoutes(app: FastifyInstance) {
  app.post('/v1/auth/otp', async (req) => {
    const { phone } = requestSchema.parse(req.body);
    const result = await requestOtp(phone);
    return result;
  });

  app.post('/v1/auth/otp/verify', async (req) => {
    const body = verifySchema.parse(req.body);
    await verifyOtp({ requestId: body.requestId, phone: body.phone, code: body.code });

    const prisma = getPrisma();
    let user = await prisma.user.findUnique({ where: { phone: body.phone }, include: { roles: true } });
    if (!user) {
      user = await prisma.user.create({
        data: {
          phone: body.phone,
          nameAr: body.nameAr?.trim() || 'مستخدم جديد',
          roles: { create: { role: 'CUSTOMER', scope: '' } },
        },
        include: { roles: true },
      });
    }
    const role = (user.roles[0]?.role ?? 'CUSTOMER') as Role;
    const pair = await issueTokenPair(user.id, role, {
      ip: (req.ip as string | undefined),
      userAgent: (req.headers['user-agent'] as string | undefined),
    });
    await audit({ actorId: user.id, action: 'AUTH.LOGIN', entity: 'User', entityId: user.id });
    return {
      user: { id: user.id, phone: user.phone, nameAr: user.nameAr, role },
      ...pair,
    };
  });

  app.post('/v1/auth/refresh', async (req) => {
    const { refreshToken } = refreshSchema.parse(req.body);
    const pair = await rotateRefreshToken(refreshToken, {
      ip: (req.ip as string | undefined),
      userAgent: (req.headers['user-agent'] as string | undefined),
    });
    return pair;
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const body = req.body ? refreshSchema.partial().parse(req.body) : {};
    if (body.refreshToken) {
      await revokeRefreshToken(body.refreshToken);
    }
    await audit({ actorId: caller.userId, action: 'AUTH.LOGOUT', entity: 'User', entityId: caller.userId });
    return { ok: true };
  });

  /**
   * POST /v1/auth/internal-admin-token — server-to-server ADMIN JWT exchange.
   *
   * Used by the Next.js BFF to mint a short-lived ADMIN access token so
   * it can call /v1/admin/* without ever forwarding a Bearer to the
   * browser. It NEVER shortcuts requireAuth / requireRole: it mints a
   * real JWT for a real ADMIN user, then the normal RBAC guard verifies
   * that JWT on the downstream request like any other.
   *
   * Hardening:
   *   - Feature-off default: unless BOTH `SAKAN_INTERNAL_ADMIN_SECRET`
   *     (≥32 chars) and `SAKAN_INTERNAL_ADMIN_USER_ID` are configured,
   *     the endpoint 404s as if it did not exist.
   *   - The presented secret comes in the Authorization header
   *     (`Bearer <secret>`), constant-time compared with `timingSafeEqual`.
   *     The secret never appears in a response, an error message, or a
   *     log line. On mismatch we return a generic 401.
   *   - The configured user is fetched from Prisma with roles; if the
   *     row is missing OR does not currently own ADMIN / SUPER_ADMIN,
   *     the endpoint refuses with 403. Rotating the user out of the
   *     admin role invalidates future issuance immediately.
   *   - Rate limiting is inherited from the global @fastify/rate-limit
   *     that main.ts installs on the whole app.
   */
  app.post('/v1/auth/internal-admin-token', async (req, reply) => {
    const secret = config.SAKAN_INTERNAL_ADMIN_SECRET;
    const uid = config.SAKAN_INTERNAL_ADMIN_USER_ID;
    if (!secret || !uid) throw notFound(); // feature disabled → not-advertised

    // Extract Bearer without leaking anything about parse failure.
    const authz = req.headers['authorization'];
    let presented = '';
    if (typeof authz === 'string' && authz.startsWith('Bearer ')) {
      presented = authz.slice(7).trim();
    }
    // Constant-time compare against padded buffers.
    const a = Buffer.from(presented);
    const b = Buffer.from(secret);
    const len = Math.max(a.length, b.length);
    const ap = Buffer.alloc(len); a.copy(ap);
    const bp = Buffer.alloc(len); b.copy(bp);
    const ok = a.length === b.length && timingSafeEqual(ap, bp);
    if (!ok) throw unauthorized('invalid service credential');

    // Look up the real user + roles. Refuse if the row is gone or if the
    // configured id lost its admin membership since last restart.
    const user = await getPrisma().user.findUnique({
      where: { id: uid },
      include: { roles: true },
    });
    if (!user) throw forbidden('service user not found');
    // Only ADMIN / SUPER_ADMIN may back the service account. FINANCE_ADMIN
    // is deliberately excluded per the operator spec — a finance-only
    // role must not be able to authenticate as a general admin.
    const ADMIN_ROLES: readonly Role[] = ['ADMIN', 'SUPER_ADMIN'];
    const effective = user.roles
      .map((r) => r.role as Role)
      .find((r) => (ADMIN_ROLES as readonly string[]).includes(r));
    if (!effective) throw forbidden('service user is not an admin');

    // Mint via the existing signAccessToken helper. TTL follows the same
    // policy every other access token uses; nothing about requireAuth or
    // requireRole is bypassed downstream.
    const accessToken = signAccessToken(user.id, effective);
    return { accessToken, tokenType: 'Bearer', role: effective, expiresIn: ACCESS_TTL_SECONDS };
  });

  app.get('/v1/auth/me', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const user = await getPrisma().user.findUnique({
      where: { id: caller.userId },
      include: { roles: true },
    });
    if (!user) throw notFound('user not found');
    return {
      id: user.id, phone: user.phone, email: user.email,
      nameAr: user.nameAr, nameEn: user.nameEn,
      roles: user.roles.map((r) => r.role),
      currentRole: caller.role,
    };
  });
}
