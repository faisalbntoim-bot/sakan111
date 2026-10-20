/**
 * Media upload flow.
 *
 *   1. Client asks the API for a signed upload URL (POST /v1/media/upload-url)
 *   2. Client PUTs the file directly to the storage provider
 *   3. Client tells the API "I'm done" (POST /v1/media) — server records the
 *      MediaAsset row + optionally invokes the malware scanner hook
 *   4. Reads happen via short-lived signed download URLs (GET /v1/media/:id/url)
 *
 * No blob ever transits the API — the file goes straight to storage.
 * Filenames are provider-generated; users cannot supply their own.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import { getPrisma } from '../db.js';
import { requireAuth, isAdminRole } from '../auth/rbac.js';
import { getStorage } from '../storage/index.js';
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from '../storage/storage-provider.js';
import { contentTypeCompatible, type DetectableMime } from '../storage/detect.js';
import { badRequest, notFound } from '../errors.js';
import { jsonSafe } from '../money.js';
import { config } from '../config.js';

/** Convert a staging providerKey (`uploads/<rest>`) into its finalized
 *  counterpart (`finalized/<rest>`). Throws when the key does not carry
 *  the expected staging prefix — finalize should never call this on
 *  anything other than a key our signUpload emitted. */
function stagingKeyToFinal(stagingKey: string): string {
  if (!stagingKey.startsWith('uploads/')) {
    throw new Error(`not a staging key: ${stagingKey}`);
  }
  return 'finalized/' + stagingKey.slice('uploads/'.length);
}

const signSchema = z.object({
  kind: z.enum(['image', 'video', 'document']),
  contentType: z.string().min(3).max(120),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  propertyId: z.string().optional(),
  // The upload path ignores any client-sent visibility value and
  // always persists `private`. The owner opts an asset into public
  // display afterwards via PATCH /v1/media/:id/showcase. This keeps
  // the single trust boundary for public exposure in one named place.
  visibility: z.enum(['private', 'public']).optional(),
});

const finalizeSchema = z.object({
  assetId: z.string().min(1).max(64),
  providerKey: z.string().min(1).max(512),
});

export default async function mediaRoutes(app: FastifyInstance) {
  // Register a wildcard content-type parser so PUT /v1/media/sandbox-upload/*
  // can accept image/* (or any binary) as raw bytes. We drain the stream
  // into a bounded buffer and discard — the sandbox provider does not
  // persist anything. Fastify's global bodyLimit still applies as an
  // outer bound.
  app.addContentTypeParser(/^(?!application\/json).*/, { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/v1/media/upload-url', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const body = signSchema.parse(req.body);
    // Extra check: contentType must match kind's allow-list (also enforced inside the provider).
    if (!ALLOWED_CONTENT_TYPES[body.kind].includes(body.contentType)) {
      throw badRequest(`contentType ${body.contentType} not allowed for kind=${body.kind}`);
    }
    // Per-kind size limits from config (tighter than MAX_UPLOAD_BYTES).
    if (body.kind === 'image' && body.sizeBytes > config.MEDIA_IMAGE_MAX_BYTES) {
      throw badRequest('image exceeds MEDIA_IMAGE_MAX_BYTES');
    }
    if (body.kind === 'video' && body.sizeBytes > config.MEDIA_VIDEO_MAX_BYTES) {
      throw badRequest('video exceeds MEDIA_VIDEO_MAX_BYTES');
    }
    // Property ownership enforcement — when a propertyId is supplied,
    // it MUST belong to the caller (or the caller is an admin).
    if (body.propertyId) {
      const prop = await getPrisma().property.findUnique({ where: { id: body.propertyId }, select: { ownerId: true } });
      if (!prop) throw notFound('property not found');
      if (prop.ownerId !== caller.userId && !isAdminRole(caller.role)) {
        throw notFound('property not found');
      }
    }
    // Force private at the trust boundary — the showcase flip is a
    // separate, explicit act. Any client-supplied `visibility` here is
    // silently ignored.
    const persistedVisibility = 'private' as const;
    const storage = getStorage();
    const signed = await storage.signUpload({
      ownerUserId: caller.userId,
      propertyId: body.propertyId,
      kind: body.kind,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: persistedVisibility,
    });
    // Persist the full sign request. This row is the sole source of truth
    // finalize consults — a fabricated providerKey with no matching row
    // gets rejected, and any attempt to swap propertyId / kind / size /
    // sha256 on finalize is caught by comparison against this record.
    await getPrisma().pendingUpload.create({
      data: {
        id: signed.assetId,
        ownerUserId: caller.userId,
        propertyId: body.propertyId ?? null,
        provider: signed.provider,
        providerKey: signed.providerKey,
        kind: body.kind,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        sha256: body.sha256,
        visibility: persistedVisibility,
        expiresAt: signed.expiresAt,
      },
    });
    return jsonSafe(signed);
  });

  /**
   * POST /v1/media (finalize) — turns a completed upload into a MediaAsset.
   *
   * Trust boundary: the request body carries ONLY `assetId` + `providerKey`.
   * Every other field (kind, contentType, sizeBytes, sha256, propertyId,
   * visibility) is loaded from the PendingUpload record we persisted when
   * we signed the URL. Nothing the client sends at finalize time can
   * flip a scope, retarget a property, or upgrade the declared size.
   *
   * The route rejects: unknown/expired/foreign pending rows, a caller who
   * did not originate the sign request, a providerKey that structurally
   * conflicts with the pending record, a stored object whose actual size /
   * SHA-256 does not match, and a stored object whose magic bytes do not
   * match the declared MIME family.
   *
   * Concurrent finalize is handled by a `updateMany({ finalizedAt: null })`
   * — only one attempt marks the pending row consumed; the losers fall
   * through the "already finalized" branch and return the existing asset
   * (200 idempotent).
   */
  app.post('/v1/media', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const body = finalizeSchema.parse(req.body);
    const isAdmin = isAdminRole(caller.role);
    const prisma = getPrisma();

    const pending = await prisma.pendingUpload.findUnique({
      where: { providerKey: body.providerKey },
    });
    if (!pending) throw notFound('media not found');

    // Bind ownership. 404 rather than 403 so callers cannot probe other
    // owners' pending records.
    if (pending.ownerUserId !== caller.userId && !isAdmin) {
      throw notFound('media not found');
    }
    if (pending.id !== body.assetId) {
      throw badRequest('providerKey does not match assetId');
    }

    // Idempotent replay — a second finalize call returns the existing
    // MediaAsset instead of failing on the unique(id) constraint. This
    // is what lets a retry after a lost response succeed cleanly.
    if (pending.finalizedAt) {
      const existing = await prisma.mediaAsset.findUnique({ where: { id: pending.id } });
      if (existing) return jsonSafe(existing);
      // finalizedAt was set but no MediaAsset exists → treat as a stuck
      // pending row and refuse rather than silently create a new one that
      // may bypass storage verification.
      throw badRequest('pending upload finalized but asset missing');
    }

    // Expiry check comes AFTER ownership and idempotent-replay checks so
    // that a caller who finished uploading right at the deadline can still
    // finalize during the small window their request travels.
    if (pending.expiresAt.getTime() < Date.now()) {
      throw badRequest('signed upload expired');
    }

    // Recheck property ownership at finalize time. The `pending` row locks
    // in which propertyId the upload targets, but the property itself may
    // have been transferred, deleted, or its owner-role revoked in the
    // window between sign and finalize. Re-verify against live DB state.
    if (pending.propertyId) {
      const prop = await prisma.property.findUnique({
        where: { id: pending.propertyId },
        select: { ownerId: true },
      });
      if (!prop) throw notFound('property not found');
      if (prop.ownerId !== caller.userId && !isAdmin) {
        throw notFound('property not found');
      }
    }

    // Trust boundary: the file at `pending.providerKey` (uploads/…) is
    // still reachable by any live signed PUT URL the client holds. Reading
    // its bytes here and moving them later is a TOCTOU: a racing PUT could
    // rewrite the file between HEAD and publish so the finalized bytes do
    // not match what we hashed. Close the window by ATOMICALLY moving the
    // upload into an attempt-scoped verifying/… key that no signed URL can
    // reach. Everything after this line reads from the quarantined copy.
    const storage = getStorage();
    const finalKey = stagingKeyToFinal(pending.providerKey);
    const attemptUuid = crypto.randomBytes(12).toString('hex');
    const verifyingKey = `verifying/${attemptUuid}-${pending.id}`;

    // Recovery from a prior finalize that crashed AFTER publish() but
    // BEFORE the DB transaction committed: the bytes already live at
    // finalKey and match pending.sha256. Return the raced-but-completable
    // path so a retry can finish the DB write without re-verifying.
    async function completeAtFinalKey(): Promise<Awaited<ReturnType<typeof jsonSafe>> | null> {
      let stat;
      try { stat = await storage.head(finalKey); }
      catch { return null; }
      if (stat.sha256 !== pending!.sha256.toLowerCase()) return null;
      if (stat.sizeBytes !== pending!.sizeBytes) return null;
      try {
        const [, created] = await prisma.$transaction([
          prisma.pendingUpload.update({ where: { id: pending!.id }, data: { finalizedAt: new Date() } }),
          prisma.mediaAsset.create({
            data: {
              id: pending!.id,
              ownerUserId: pending!.ownerUserId,
              propertyId: pending!.propertyId,
              kind: pending!.kind,
              provider: pending!.provider,
              providerKey: finalKey,
              mimeType: pending!.contentType,
              sizeBytes: pending!.sizeBytes,
              sha256: pending!.sha256,
              visibility: pending!.visibility,
            },
          }),
        ]);
        return jsonSafe(created);
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          const existing = await prisma.mediaAsset.findUnique({ where: { id: pending!.id } });
          if (existing) return jsonSafe(existing);
        }
        throw e;
      }
    }

    try {
      await storage.stage(pending.providerKey, verifyingKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'NOT_FOUND') {
        // Either bytes never uploaded, or a previous finalize attempt
        // already staged / published. Try the recovery path against
        // finalKey (crash-safe resume) before we give up.
        const recovered = await completeAtFinalKey();
        if (recovered) return recovered;
        // Still nothing — maybe a racing finalize is mid-flight. Poll
        // briefly for its MediaAsset row before returning 404.
        for (let i = 0; i < 20; i++) {
          const existing = await prisma.mediaAsset.findUnique({ where: { id: pending.id } });
          if (existing) return jsonSafe(existing);
          await new Promise((r) => setTimeout(r, 50));
        }
        throw notFound('media bytes missing');
      }
      if (msg === 'ALREADY_STAGED') {
        // Another finalize attempt got here first (astronomically unlikely
        // uuid collision, but handle it). Wait for its MediaAsset.
        for (let i = 0; i < 20; i++) {
          const existing = await prisma.mediaAsset.findUnique({ where: { id: pending.id } });
          if (existing) return jsonSafe(existing);
          await new Promise((r) => setTimeout(r, 50));
        }
        throw badRequest('finalize collision — try again');
      }
      throw badRequest(`stage failed: ${msg}`);
    }

    // At this point we OWN the verifying/… object. Verify it. We only
    // unstage on DELIBERATE verification failures (size / sha256 / MIME
    // mismatch — the file is defensibly bad). Transient errors (network
    // blip during HEAD, provider outage) leave the verifying object in
    // place: a cleanup job / operator can inspect it, and no bytes are
    // silently discarded. A retry after a transient error will require a
    // fresh signed upload because attempt-uuid is not persisted — this is
    // documented in REVIEW-V5.md as a known limitation.
    let stat;
    try {
      stat = await storage.head(verifyingKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'NOT_FOUND') throw notFound('media bytes missing');
      // Deliberately no unstage() — keep the bytes for investigation.
      throw badRequest(`storage HEAD failed: ${msg}`);
    }
    try {
      if (stat.sizeBytes !== pending.sizeBytes) {
        throw badRequest(`size mismatch: stored=${stat.sizeBytes} pending=${pending.sizeBytes}`);
      }
      if (stat.sha256 === null) {
        throw badRequest('storage did not return sha256 — asset cannot be verified');
      }
      if (stat.sha256 !== pending.sha256.toLowerCase()) {
        throw badRequest('sha256 mismatch');
      }
      if (stat.detectedContentType === null) {
        throw badRequest('storage could not detect content-type — asset cannot be verified');
      }
      if (!contentTypeCompatible(pending.contentType, stat.detectedContentType as DetectableMime)) {
        throw badRequest(`content-type mismatch: stored=${stat.detectedContentType} declared=${pending.contentType}`);
      }
    } catch (e) {
      // Deliberate rejection: the file bytes are wrong for the declared
      // attributes. Discarding them is the right thing to do.
      await storage.unstage(verifyingKey).catch(() => {});
      throw e;
    }

    // Promote the verified quarantine copy to its final read-only key.
    try {
      await storage.publish(verifyingKey, finalKey);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'ALREADY_PUBLISHED') {
        // finalKey exists — someone else's attempt published, OR a prior
        // crash left a partial/mismatching file there. completeAtFinalKey
        // re-verifies the actual bytes (size + sha256) before committing.
        // If it returns null the file is not what we expected — REFUSE.
        // Falling through to the DB create would insert a MediaAsset
        // pointing at unverified bytes.
        const recovered = await completeAtFinalKey();
        if (recovered) return recovered;
        throw badRequest('publish reported ALREADY_PUBLISHED but bytes at finalKey did not match — refusing to create asset');
      }
      // Transient publish failure: leave the verifying object for
      // investigation rather than deleting the only good copy.
      throw badRequest(`publish failed: ${msg}`);
    }

    // Consume pending + create MediaAsset in a single DB transaction.
    // On failure we DO NOT rollback the bytes at finalKey: rolling back
    // would move the bytes into an attempt-scoped verifying/ location
    // that the next retry cannot address (retry generates a fresh uuid).
    // Instead we leave the bytes at finalKey; retry's completeAtFinalKey()
    // path finds them, re-verifies size + sha256, and completes the DB
    // write. The verified copy is what a retry consumes — no re-upload
    // required.
    let asset;
    try {
      const [, created] = await prisma.$transaction([
        prisma.pendingUpload.update({
          where: { id: pending.id },
          data: { finalizedAt: new Date() },
        }),
        prisma.mediaAsset.create({
          data: {
            id: pending.id,
            ownerUserId: pending.ownerUserId,
            propertyId: pending.propertyId,
            kind: pending.kind,
            provider: pending.provider,
            providerKey: finalKey,
            mimeType: pending.contentType,
            sizeBytes: pending.sizeBytes,
            sha256: pending.sha256,
            visibility: pending.visibility,
          },
        }),
      ]);
      asset = created;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'P2002') {
        // Racing finalize won. Return its committed row.
        const existing = await prisma.mediaAsset.findUnique({ where: { id: pending.id } });
        if (existing) return jsonSafe(existing);
      }
      // Do NOT rollback the bytes. Leave them at finalKey; the next
      // finalize attempt sees stage() fail (uploads/ gone) and picks
      // up the bytes from finalKey via completeAtFinalKey().
      throw e;
    }

    // Malware scan hook (fire-and-forget — implementers can await if desired).
    await storage.malwareScannerHook?.(asset.providerKey);
    return jsonSafe(asset);
  });

  app.get('/v1/media/:id/url', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const prisma = getPrisma();
    const asset = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw notFound('media not found');
    // Private assets only readable by the owner or an admin. Public assets by anyone authed.
    if (asset.visibility === 'private') {
      if (asset.ownerUserId !== caller.userId && !isAdminRole(caller.role)) {
        throw notFound('media not found');
      }
    }
    const signed = await getStorage().signDownload(asset.providerKey, 300);
    return jsonSafe(signed);
  });

  /**
   * GET /v1/media — list media the caller owns.
   *
   * With `?propertyId=<id>` limits to a single property. The caller
   * must be the property owner (or an admin) — non-owners get an empty
   * list rather than a 403, so probe attempts can't distinguish
   * "property doesn't exist" from "property exists but isn't yours".
   *
   * Response includes a fresh signed download URL per asset so the
   * gallery renders in one round-trip.
   */
  const listQuery = z.object({
    propertyId: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(60),
  });
  app.get('/v1/media', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const q = listQuery.parse(req.query ?? {});
    const prisma = getPrisma();
    const storage = getStorage();

    // Ownership scoping: filter to caller-owned rows unless the caller
    // is admin AND explicitly targeting one property.
    const where: Record<string, unknown> = { ownerUserId: caller.userId };
    if (q.propertyId) where.propertyId = q.propertyId;
    if (isAdminRole(caller.role) && q.propertyId) {
      // Admins may list any property's media by id.
      delete where.ownerUserId;
    }
    const rows = await prisma.mediaAsset.findMany({
      where, orderBy: { createdAt: 'asc' }, take: q.limit,
    });
    const items = await Promise.all(rows.map(async (r) => {
      let signedUrl: string | null = null;
      try {
        const s = await storage.signDownload(r.providerKey, 300);
        signedUrl = s.url;
      } catch { signedUrl = null; }
      return {
        id: r.id,
        propertyId: r.propertyId,
        kind: r.kind,
        mimeType: r.mimeType,
        sizeBytes: r.sizeBytes,
        visibility: r.visibility,
        createdAt: r.createdAt,
        // Never expose ownerUserId/providerKey to the public shape.
        url: signedUrl,
      };
    }));
    return jsonSafe({ items });
  });

  /**
   * DELETE /v1/media/:id — owner-only.
   *
   * Removes the DB row. Storage-side deletion is delegated to the
   * provider when it exposes a hook; sandbox is in-memory anyway.
   * Non-owners see 404 so IDs cannot be probed.
   */
  /**
   * PATCH /v1/media/:id/showcase — owner-only.
   *
   * Flips a MediaAsset's `visibility` between 'private' (default — only
   * the owner can see it via signed URL) and 'public' (eligible for
   * surfacing on the public homepage feed once the parent property is
   * PUBLISHED). Non-owners get 404 — IDs are not probable.
   *
   * This is the ONLY path by which an asset becomes publicly surfaced.
   * The upload endpoints keep visibility='private' no matter what the
   * client POSTs. Removing it is deliberately a separate, explicit act.
   */
  app.patch('/v1/media/:id/showcase', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const body = req.body as { public?: unknown } | undefined;
    const wantPublic = body?.public === true;
    const prisma = getPrisma();
    const asset = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw notFound('media not found');
    if (asset.ownerUserId !== caller.userId && !isAdminRole(caller.role)) {
      throw notFound('media not found');
    }
    const updated = await prisma.mediaAsset.update({
      where: { id },
      data: { visibility: wantPublic ? 'public' : 'private' },
    });
    return {
      id: updated.id,
      visibility: updated.visibility,
      propertyId: updated.propertyId,
      kind: updated.kind,
    };
  });

  app.delete('/v1/media/:id', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const { id } = req.params as { id: string };
    const prisma = getPrisma();
    const asset = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) throw notFound('media not found');
    if (asset.ownerUserId !== caller.userId && !isAdminRole(caller.role)) {
      throw notFound('media not found');
    }
    await prisma.mediaAsset.delete({ where: { id } });
    // Best-effort storage-side cleanup; a failure here does not fail the
    // request (the DB row is gone so the file is orphaned but harmless).
    const storage = getStorage();
    const del = (storage as unknown as { deleteObject?: (key: string) => Promise<void> }).deleteObject;
    if (typeof del === 'function') { try { await del.call(storage, asset.providerKey); } catch { /* ignore */ } }
    return { ok: true };
  });

  /**
   * PUT /v1/media/sandbox-upload/* — dev-only byte sink for the sandbox
   * storage provider.
   *
   * Bytes are now retained in memory by SandboxStorageProvider so finalize
   * can HEAD them + verify size + SHA-256. Production sinks (`local` / `s3`)
   * have their own persisted routes below. This route is guarded to dev/test
   * so a misconfigured deployment cannot accept raw file bytes into RAM.
   */
  app.put('/v1/media/sandbox-upload/*', {
    bodyLimit: MAX_UPLOAD_BYTES,
    onRequest: async (req, reply) => {
      if (config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
    },
  }, async (req, reply) => {
    if (config.STORAGE_PROVIDER !== 'sandbox') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    const providerKey = (req.params as { '*': string })['*'] ?? '';
    if (!providerKey || providerKey.length > 512 || providerKey.includes('..')) {
      return reply.code(400).send({ error: 'BAD_KEY' });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: 'EMPTY_BODY' });
    }
    // Refuse writes into a slot whose pending row has already been
    // finalized. Defence in depth against a client that retains the
    // signed URL past the finalize response and retries the PUT.
    const pending = await getPrisma().pendingUpload.findUnique({ where: { providerKey } });
    if (pending?.finalizedAt) {
      return reply.code(409).send({ error: 'ALREADY_FINALIZED' });
    }
    // Lazy import so sandbox module code is not pulled into the production
    // bundle graph when STORAGE_PROVIDER != sandbox.
    const { _sandboxWrite } = await import('../storage/sandbox.js');
    _sandboxWrite(providerKey, body);
    return reply.code(200).send({ ok: true });
  });

  /**
   * PUT /v1/media/local-upload/* — production byte sink for the
   * LocalStorageProvider.
   *
   * Verifies the HMAC signature the provider issued (bound to
   * providerKey + expiry + expected size). Writes bytes to
   * LOCAL_STORAGE_DIR — path is resolved by the provider so a bad key
   * cannot escape the root. No auth header required on this URL:
   * possession of a fresh signature IS the authorization, exactly as
   * with a signed S3 PUT URL.
   */
  app.put('/v1/media/local-upload/*', {
    bodyLimit: MAX_UPLOAD_BYTES,
  }, async (req, reply) => {
    if (config.STORAGE_PROVIDER !== 'local') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    // Fastify wildcard param: everything after /v1/media/local-upload/
    const providerKey = (req.params as { '*': string })['*'] ?? '';
    const q = req.query as { exp?: string; size?: string; sig?: string };
    const exp = Number(q.exp);
    const size = Number(q.size);
    const sig = String(q.sig ?? '');

    // Delegate verification to the provider — same HMAC key + shape.
    const storage = getStorage();
    const local = storage as unknown as {
      config?: { dir: string; signingSecret: string };
      writeBytes?: (key: string, buf: Buffer) => Promise<void>;
    };
    if (!local.config || !local.writeBytes) {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    // Local verifier is exposed via storage/local.js — import lazily to keep
    // sandbox/s3 boots free of fs.
    const { verifySignedUpload, verifyKey } = await import('../storage/local.js');
    try { verifyKey(providerKey); } catch { return reply.code(400).send({ error: 'BAD_KEY' }); }
    if (!verifySignedUpload(local.config, providerKey, exp, size, sig)) {
      return reply.code(401).send({ error: 'INVALID_UPLOAD_SIGNATURE' });
    }

    // Refuse writes to a staging slot whose pending row has already been
    // finalized. Even if the signed URL is still valid clock-wise, a
    // consumed pending row means finalize published + swapped the bytes
    // into `finalized/…`; letting a fresh PUT rewrite the staging file
    // would confuse operators and give an attacker a place to store bytes
    // in the caller's slot post-finalize.
    const pending = await getPrisma().pendingUpload.findUnique({ where: { providerKey } });
    if (pending?.finalizedAt) {
      return reply.code(409).send({ error: 'ALREADY_FINALIZED' });
    }

    // Bound the read to the signed size. Refuse if the incoming body
    // does not match — this prevents a signature reuse for a different
    // payload / a chunked stream sneaking more bytes than declared.
    const body = req.body;
    if (!Buffer.isBuffer(body)) return reply.code(400).send({ error: 'EMPTY_BODY' });
    if (body.length !== size) return reply.code(400).send({ error: 'SIZE_MISMATCH' });

    await local.writeBytes(providerKey, body);
    return reply.code(200).send({ ok: true });
  });

  /**
   * GET /v1/media/local-stream/*?exp=<ms>&sig=<hex> — HMAC-signed reads.
   *
   * The signature is minted by `GET /v1/media/:id/url` after that endpoint
   * has enforced ownership + visibility. This route accepts NO Bearer
   * because `<video>`/`<img>` tags cannot inject one; possession of a
   * fresh signature IS the authorization for the URL's TTL window,
   * exactly as with an S3 signed GET.
   *
   * The signature is bound to providerKey + expiry only. It does not
   * carry any user identity, so it cannot be replayed to reach a
   * different owner's object. Anyone who can hand out these URLs must
   * have already done the ownership check (that's what `GET :id/url` does).
   */
  app.get('/v1/media/local-stream/*', async (req, reply) => {
    if (config.STORAGE_PROVIDER !== 'local') {
      return reply.code(404).send({ error: 'NOT_FOUND' });
    }
    const providerKey = (req.params as { '*': string })['*'] ?? '';
    const q = req.query as { exp?: string; sig?: string };
    const exp = Number(q.exp);
    const sig = String(q.sig ?? '');
    // Provider-specific verify. Lazy import so sandbox/s3 boots don't drag fs.
    const { verifySignedDownload, verifyKey } = await import('../storage/local.js');
    try { verifyKey(providerKey); } catch { return reply.code(400).send({ error: 'BAD_KEY' }); }
    const storage = getStorage();
    const localCfg = (storage as unknown as { config?: { signingSecret: string; dir: string } }).config;
    if (!localCfg) return reply.code(404).send({ error: 'NOT_FOUND' });
    if (!verifySignedDownload(localCfg, providerKey, exp, sig)) {
      return reply.code(401).send({ error: 'INVALID_DOWNLOAD_SIGNATURE' });
    }
    // Look up the row for content-type (and visibility sanity — a public
    // asset returning a signed URL is fine; we still refuse to serve a
    // row that has been deleted since the URL was minted).
    const prisma = getPrisma();
    const asset = await prisma.mediaAsset.findFirst({ where: { providerKey } });
    if (!asset) return reply.code(404).send({ error: 'NOT_FOUND' });

    const local = storage as unknown as { openRead?: (key: string, o?: { start?: number; end?: number }) => Promise<{ stream: NodeJS.ReadableStream; size: number }> };
    if (!local.openRead) return reply.code(404).send({ error: 'NOT_FOUND' });

    // Parse a single-range header if present. Ignore multi-range.
    const rangeHeader = req.headers['range'];
    if (typeof rangeHeader === 'string' && rangeHeader.startsWith('bytes=')) {
      const m = rangeHeader.slice(6).match(/^(\d+)-(\d*)$/);
      if (!m) return reply.code(416).send({ error: 'INVALID_RANGE' });
      // First get the total size so we can clamp the end and set headers.
      // openRead without opts returns the whole file but also gives us `size`.
      const probe = await local.openRead(providerKey);
      // Immediately discard the probe stream — we only need `size`.
      (probe.stream as unknown as { destroy?: (e?: Error) => void }).destroy?.();
      const start = Number(m[1]);
      const end = m[2] === '' ? probe.size - 1 : Math.min(probe.size - 1, Number(m[2]));
      if (start > end || start >= probe.size) {
        reply.header('content-range', `bytes */${probe.size}`);
        return reply.code(416).send();
      }
      const { stream } = await local.openRead(providerKey, { start, end });
      reply.code(206);
      reply.header('accept-ranges', 'bytes');
      reply.header('content-range', `bytes ${start}-${end}/${probe.size}`);
      reply.header('content-length', String(end - start + 1));
      reply.header('content-type', asset.mimeType);
      reply.header('cross-origin-resource-policy', 'cross-origin');
      return reply.send(stream);
    }

    // No Range → send the whole file.
    const { stream, size } = await local.openRead(providerKey);
    reply.header('accept-ranges', 'bytes');
    reply.header('content-length', String(size));
    reply.header('content-type', asset.mimeType);
    // The signed URL itself IS the authorization; it is designed to
    // load from any origin that holds the signature (an <img>/<video>
    // on sakanhubb.com fetching from media.sakanhubb.com, or a Next.js
    // app on another port in dev). Explicitly override helmet's
    // same-site CORP so cross-origin fetches work.
    reply.header('cross-origin-resource-policy', 'cross-origin');
    return reply.send(stream);
  });
}
