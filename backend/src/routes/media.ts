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
import { getPrisma } from '../db.js';
import { requireAuth, isAdminRole } from '../auth/rbac.js';
import { getStorage } from '../storage/index.js';
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from '../storage/storage-provider.js';
import { badRequest, notFound } from '../errors.js';
import { jsonSafe } from '../money.js';
import { config } from '../config.js';

const signSchema = z.object({
  kind: z.enum(['image', 'video', 'document']),
  contentType: z.string().min(3).max(120),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  propertyId: z.string().optional(),
  visibility: z.enum(['private', 'public']).default('private'),
});

const finalizeSchema = z.object({
  assetId: z.string().min(1),
  providerKey: z.string().min(1),
  kind: z.enum(['image', 'video', 'document']),
  contentType: z.string().min(3).max(120),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  propertyId: z.string().optional(),
  visibility: z.enum(['private', 'public']).default('private'),
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
    const storage = getStorage();
    const signed = await storage.signUpload({
      ownerUserId: caller.userId,
      propertyId: body.propertyId,
      kind: body.kind,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
      sha256: body.sha256,
      visibility: body.visibility,
    });
    return jsonSafe(signed);
  });

  app.post('/v1/media', async (req, reply) => {
    const caller = requireAuth(req, reply);
    const body = finalizeSchema.parse(req.body);
    const asset = await getPrisma().mediaAsset.create({
      data: {
        id: body.assetId,
        ownerUserId: caller.userId,
        propertyId: body.propertyId ?? null,
        kind: body.kind,
        provider: getStorage().name,
        providerKey: body.providerKey,
        mimeType: body.contentType,
        sizeBytes: body.sizeBytes,
        sha256: body.sha256,
        visibility: body.visibility,
      },
    });
    // Malware scan hook (fire-and-forget — implementers can await if desired).
    await getStorage().malwareScannerHook?.(asset.providerKey);
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
   * The sandbox provider hands out `sandbox://...` URLs which browsers
   * cannot PUT to; the web client rewrites those URLs to hit THIS route
   * so end-to-end uploads work in development without a real S3 / R2.
   * Production must configure a real provider — this route 404s outside
   * NODE_ENV=development|test so a misconfigured deployment cannot
   * accidentally accept raw file bytes.
   */
  app.put('/v1/media/sandbox-upload/*', {
    bodyLimit: MAX_UPLOAD_BYTES,
    // Accept any content-type as raw bytes into a Buffer we then discard.
    // Fastify's default JSON parser doesn't handle image/*, so a wildcard
    // parser is registered locally.
    onRequest: async (req, reply) => {
      if (config.NODE_ENV !== 'development' && config.NODE_ENV !== 'test') {
        return reply.code(404).send({ error: 'NOT_FOUND' });
      }
    },
  }, async (_req, reply) => {
    // Body is consumed but discarded; sandbox does not persist anything.
    return reply.code(200).send({ ok: true });
  });
}
