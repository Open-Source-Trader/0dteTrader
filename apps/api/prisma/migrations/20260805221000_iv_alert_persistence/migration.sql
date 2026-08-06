CREATE TABLE "iv_alert_preferences" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "symbols" TEXT[] NOT NULL,
  "lookbackMinutes" INTEGER NOT NULL DEFAULT 30,
  "thresholdK" DOUBLE PRECISION NOT NULL DEFAULT 3,
  "consecutiveBreaches" INTEGER NOT NULL DEFAULT 2,
  "warmupMinutes" INTEGER NOT NULL DEFAULT 10,
  "warmupSamples" INTEGER NOT NULL DEFAULT 10,
  "cooldownMinutes" INTEGER NOT NULL DEFAULT 5,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "iv_alert_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iv_alert_preferences_schema_version_check" CHECK ("schemaVersion" = 1),
  CONSTRAINT "iv_alert_preferences_symbols_check" CHECK (
    cardinality("symbols") BETWEEN 1 AND 3
    AND "symbols" <@ ARRAY['SPX', 'NDX', 'RUT']::TEXT[]
    AND (
      cardinality("symbols") = 1
      OR (
        "symbols"[1] <> "symbols"[2]
        AND (
          cardinality("symbols") = 2
          OR ("symbols"[1] <> "symbols"[3] AND "symbols"[2] <> "symbols"[3])
        )
      )
    )
  ),
  CONSTRAINT "iv_alert_preferences_lookback_check" CHECK ("lookbackMinutes" BETWEEN 5 AND 240),
  CONSTRAINT "iv_alert_preferences_threshold_check" CHECK ("thresholdK" BETWEEN 0.1 AND 20),
  CONSTRAINT "iv_alert_preferences_consecutive_check" CHECK ("consecutiveBreaches" BETWEEN 1 AND 10),
  CONSTRAINT "iv_alert_preferences_warmup_minutes_check" CHECK ("warmupMinutes" BETWEEN 0 AND 60),
  CONSTRAINT "iv_alert_preferences_warmup_samples_check" CHECK ("warmupSamples" BETWEEN 1 AND 240),
  CONSTRAINT "iv_alert_preferences_cooldown_check" CHECK ("cooldownMinutes" BETWEEN 0 AND 1440)
);

CREATE UNIQUE INDEX "iv_alert_preferences_userId_key"
ON "iv_alert_preferences"("userId");

ALTER TABLE "iv_alert_preferences"
ADD CONSTRAINT "iv_alert_preferences_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "iv_alert_detector_states" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "symbol" TEXT NOT NULL,
  "samples" JSONB NOT NULL,
  "firstPostResetAt" TIMESTAMP(3),
  "lastProcessedAt" TIMESTAMP(3),
  "streakDirection" TEXT,
  "streakCount" INTEGER NOT NULL DEFAULT 0,
  "cooldownUntil" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "iv_alert_detector_states_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iv_alert_detector_states_symbol_check" CHECK ("symbol" IN ('SPX', 'NDX', 'RUT')),
  CONSTRAINT "iv_alert_detector_states_direction_check" CHECK ("streakDirection" IS NULL OR "streakDirection" IN ('expansion', 'crush')),
  CONSTRAINT "iv_alert_detector_states_streak_check" CHECK ("streakCount" BETWEEN 0 AND 10),
  CONSTRAINT "iv_alert_detector_states_version_check" CHECK ("version" >= 0),
  CONSTRAINT "iv_alert_detector_states_samples_check" CHECK (jsonb_typeof("samples") = 'array')
);

CREATE UNIQUE INDEX "iv_alert_detector_states_userId_symbol_key"
ON "iv_alert_detector_states"("userId", "symbol");

CREATE INDEX "iv_alert_detector_states_symbol_lastProcessedAt_idx"
ON "iv_alert_detector_states"("symbol", "lastProcessedAt");

ALTER TABLE "iv_alert_detector_states"
ADD CONSTRAINT "iv_alert_detector_states_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
