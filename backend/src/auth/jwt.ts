/**
 * JWT service — HS256 access tokens (short-lived) + opaque refresh tokens (rotated).
 *
 * Access token claims: { sub: userId, role, iss, exp, iat, jti }
 * Refresh tokens are OPAQUE (random 32 bytes, base64url) stored ONLY as sha256 in DB.
 * Rotation: verifying a refresh token issues a fresh pair and marks the presented one revoked.
 */

import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getPrisma } from '../db.js';
import { unauthorized } from '../errors.js';
import type { Role } from './rbac.js';

export const ACCESS_TTL_SECONDS = 60 * 15;              // 15 min
const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;   // 30 days

export interface AccessClaims {
  sub: string;    // userId
  role: Role;
  jti?: string;
  iat?: number;
  exp?: number;
  iss?: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessExpiresIn: number;
  refreshExpiresIn: number;
}

export function signAccessToken(userId: string, role: Role): string {
  return jwt.sign(
    { sub: userId, role },
    config.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: ACCESS_TTL_SECONDS, issuer: config.JWT_ISSUER, jwtid: crypto.randomUUID() },
  );
}

/** Returns { userId, role } or throws `unauthorized`. */
export function verifyAccessToken(token: string): { userId: string; role: Role } {
  try {
    const payload = jwt.verify(token, config.JWT_SECRET, { algorithms: ['HS256'], issuer: config.JWT_ISSUER }) as AccessClaims;
    if (!payload.sub || !payload.role) throw unauthorized('invalid token payload');
    return { userId: payload.sub, role: payload.role };
  } catch {
    throw unauthorized('invalid or expired token');
  }
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function newRefreshToken(userId: string, parentId: string | null, ctx: { ip?: string; userAgent?: string }): Promise<string> {
  const raw = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashRefreshToken(raw);
  await getPrisma().refreshToken.create({
    data: {
      userId,
      tokenHash,
      parentId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
      expiresAt: new Date(Date.now() + REFRESH_TTL_SECONDS * 1000),
    },
  });
  return raw;
}

export async function issueTokenPair(userId: string, role: Role, ctx: { ip?: string; userAgent?: string } = {}): Promise<TokenPair> {
  const accessToken = signAccessToken(userId, role);
  const refreshToken = await newRefreshToken(userId, null, ctx);
  return {
    accessToken, refreshToken,
    accessExpiresIn: ACCESS_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TTL_SECONDS,
  };
}

/** Rotate: verify the presented refresh token, revoke it, issue a fresh pair. */
export async function rotateRefreshToken(presentedRefresh: string, ctx: { ip?: string; userAgent?: string } = {}): Promise<TokenPair> {
  const prisma = getPrisma();
  const tokenHash = hashRefreshToken(presentedRefresh);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!row) throw unauthorized('unknown refresh token');
  if (row.revokedAt) throw unauthorized('refresh token revoked');
  if (row.expiresAt.getTime() < Date.now()) throw unauthorized('refresh token expired');

  const user = await prisma.user.findUnique({ where: { id: row.userId }, include: { roles: true } });
  if (!user) throw unauthorized('user not found');

  // The user's primary role is the first role granted (dev-simple; production would resolve per-scope).
  const role = (user.roles[0]?.role ?? 'CUSTOMER') as Role;

  const accessToken = signAccessToken(user.id, role);
  const refreshToken = await newRefreshToken(user.id, row.id, ctx);
  // Revoke the presented token AFTER minting the new one — no window of no-valid-token.
  await prisma.refreshToken.update({ where: { id: row.id }, data: { revokedAt: new Date() } });

  return {
    accessToken, refreshToken,
    accessExpiresIn: ACCESS_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TTL_SECONDS,
  };
}

export async function revokeRefreshToken(presentedRefresh: string): Promise<void> {
  const tokenHash = hashRefreshToken(presentedRefresh);
  await getPrisma().refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  await getPrisma().refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
