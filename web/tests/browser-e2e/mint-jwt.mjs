#!/usr/bin/env node
/**
 * HS256 JWT minter — same algorithm the backend verifies.
 *
 * Usage:
 *   node mint-jwt.mjs <sub> <role> <issuer> <secret> <ttl_seconds>
 *
 * Keeps the test suite from adding `jsonwebtoken` to the web
 * package.json just for a 20-line signer.
 */
import crypto from 'node:crypto';

const [, , sub, role, issuer, secret, ttlStr] = process.argv;
if (!sub || !role || !issuer || !secret) {
  console.error('usage: mint-jwt.mjs <sub> <role> <issuer> <secret> [ttlSeconds]');
  process.exit(2);
}
const ttl = Number(ttlStr || 900);
const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT' };
const payload = { sub, role, iss: issuer, iat: now, exp: now + ttl, jti: crypto.randomUUID() };

function b64url(x) {
  return Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify(payload));
const sig = crypto.createHmac('sha256', secret).update(unsigned).digest();
const sigB64 = sig.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
process.stdout.write(unsigned + '.' + sigB64);
