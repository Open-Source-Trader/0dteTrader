ALTER TABLE "options_analytics_snapshots"
ADD COLUMN "atmIv" DOUBLE PRECISION,
ADD COLUMN "detectorProcessedAt" TIMESTAMP(3);

-- Rows that predate the detector marker were captured before live IV alert
-- processing existed. Mark them complete so historical retention cannot fill
-- the bounded pending-recovery batch and block current market captures.
UPDATE "options_analytics_snapshots"
SET "detectorProcessedAt" = "createdAt";

CREATE INDEX "options_analytics_snapshots_atmIv_idx"
ON "options_analytics_snapshots"("atmIv");

CREATE INDEX "options_analytics_detector_pending_idx"
ON "options_analytics_snapshots"("captureReason", "resolutionMinutes", "detectorProcessedAt", "bucket");
