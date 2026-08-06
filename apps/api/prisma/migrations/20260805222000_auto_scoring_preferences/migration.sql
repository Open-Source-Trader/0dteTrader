CREATE TABLE "auto_scoring_preferences" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "preset" TEXT NOT NULL,
  "targetAbsDelta" DOUBLE PRECISION NOT NULL,
  "strikeRungs" INTEGER NOT NULL,
  "maxSpreadBps" DOUBLE PRECISION NOT NULL,
  "maxPremiumDollars" DOUBLE PRECISION NOT NULL,
  "minOpenInterest" INTEGER NOT NULL,
  "gammaMode" TEXT NOT NULL,
  "deltaWeight" DOUBLE PRECISION NOT NULL,
  "spreadWeight" DOUBLE PRECISION NOT NULL,
  "openInterestWeight" DOUBLE PRECISION NOT NULL,
  "gammaWeight" DOUBLE PRECISION NOT NULL,
  "ivWeight" DOUBLE PRECISION NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "auto_scoring_preferences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "auto_scoring_preferences_schema_version_check" CHECK ("schemaVersion" = 1),
  CONSTRAINT "auto_scoring_preferences_preset_check" CHECK ("preset" IN ('conservative', 'aggressive', 'custom')),
  CONSTRAINT "auto_scoring_preferences_target_delta_check" CHECK ("targetAbsDelta" BETWEEN 0.01 AND 0.99),
  CONSTRAINT "auto_scoring_preferences_strike_rungs_check" CHECK ("strikeRungs" BETWEEN 0 AND 20),
  CONSTRAINT "auto_scoring_preferences_spread_check" CHECK ("maxSpreadBps" BETWEEN 0 AND 10000),
  CONSTRAINT "auto_scoring_preferences_premium_check" CHECK ("maxPremiumDollars" > 0 AND "maxPremiumDollars" <= 1000000),
  CONSTRAINT "auto_scoring_preferences_open_interest_check" CHECK ("minOpenInterest" BETWEEN 0 AND 1000000000),
  CONSTRAINT "auto_scoring_preferences_gamma_mode_check" CHECK ("gammaMode" IN ('seek', 'avoid')),
  CONSTRAINT "auto_scoring_preferences_weights_check" CHECK (
    "deltaWeight" BETWEEN 0 AND 1
    AND "spreadWeight" BETWEEN 0 AND 1
    AND "openInterestWeight" BETWEEN 0 AND 1
    AND "gammaWeight" BETWEEN 0 AND 1
    AND "ivWeight" BETWEEN 0 AND 1
    AND "deltaWeight" + "spreadWeight" + "openInterestWeight" + "gammaWeight" + "ivWeight" > 0
  )
);

CREATE UNIQUE INDEX "auto_scoring_preferences_userId_key"
ON "auto_scoring_preferences"("userId");

ALTER TABLE "auto_scoring_preferences"
ADD CONSTRAINT "auto_scoring_preferences_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
