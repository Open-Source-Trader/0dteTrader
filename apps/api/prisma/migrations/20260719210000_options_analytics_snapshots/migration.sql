-- Quality-aware exact-expiration options analytics capture.
CREATE TABLE "options_analytics_snapshots" (
    "id" UUID NOT NULL,
    "symbol" TEXT NOT NULL,
    "expiration" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "settlementAt" TIMESTAMP(3) NOT NULL,
    "bucket" TIMESTAMP(3) NOT NULL,
    "captureReason" TEXT NOT NULL,
    "resolutionMinutes" INTEGER NOT NULL,
    "calculationVersion" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB NOT NULL,
    "quality" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "options_analytics_snapshots_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "options_analytics_snapshots_captureReason_check"
      CHECK ("captureReason" IN ('core', 'viewed')),
    CONSTRAINT "options_analytics_snapshots_resolutionMinutes_check"
      CHECK ("resolutionMinutes" IN (1, 5))
);

CREATE UNIQUE INDEX "options_analytics_snapshot_identity_key"
ON "options_analytics_snapshots"(
  "symbol", "expiration", "bucket", "calculationVersion", "resolutionMinutes"
);

CREATE INDEX "options_analytics_snapshots_resolutionMinutes_bucket_idx"
ON "options_analytics_snapshots"("resolutionMinutes", "bucket");

-- Cross-instance lease for the once-per-minute core capture and maintenance.
CREATE TABLE "scheduled_job_leases" (
    "name" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_job_leases_pkey" PRIMARY KEY ("name")
);

CREATE INDEX "scheduled_job_leases_expiresAt_idx"
ON "scheduled_job_leases"("expiresAt");
