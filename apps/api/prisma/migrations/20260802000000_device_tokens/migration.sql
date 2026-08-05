-- Push notifications: devices registered for APNs delivery. `token` is
-- globally unique — re-registering moves the device to the registering
-- account. Rows are pruned when APNs reports the token dead.
CREATE TABLE "device_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "platform" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "device_tokens_token_key" ON "device_tokens"("token");

CREATE INDEX "device_tokens_userId_idx" ON "device_tokens"("userId");

ALTER TABLE "device_tokens" ADD CONSTRAINT "device_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
