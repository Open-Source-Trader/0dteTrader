-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tradingProvider" TEXT NOT NULL DEFAULT 'webull';

-- CreateTable
CREATE TABLE "broker_credentials" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'webull',
    "environment" TEXT NOT NULL DEFAULT 'live',
    "encSecrets" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "broker_api_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'webull',
    "environment" TEXT NOT NULL DEFAULT 'live',
    "encToken" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "broker_api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "broker_credentials_userId_provider_environment_key" ON "broker_credentials"("userId", "provider", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "broker_api_tokens_userId_provider_environment_key" ON "broker_api_tokens"("userId", "provider", "environment");

-- AddForeignKey
ALTER TABLE "broker_credentials" ADD CONSTRAINT "broker_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "broker_api_tokens" ADD CONSTRAINT "broker_api_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

