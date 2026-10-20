-- Migration: add_pending_upload
--
-- Introduces PendingUpload — the persisted record of every signed upload
-- URL we hand out. POST /v1/media finalize consults this row exclusively
-- and refuses fabricated / expired / foreign providerKey values.

-- CreateTable
CREATE TABLE "PendingUpload" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerUserId" TEXT NOT NULL,
    "propertyId" TEXT,
    "provider" TEXT NOT NULL,
    "providerKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "visibility" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finalizedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "PendingUpload_providerKey_key" ON "PendingUpload"("providerKey");
CREATE INDEX "PendingUpload_ownerUserId_idx" ON "PendingUpload"("ownerUserId");
CREATE INDEX "PendingUpload_expiresAt_idx" ON "PendingUpload"("expiresAt");
