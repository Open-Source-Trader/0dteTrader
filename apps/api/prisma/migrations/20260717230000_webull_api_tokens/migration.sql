-- CreateTable
CREATE TABLE "webull_api_tokens" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "encToken" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webull_api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webull_api_tokens_userId_key" ON "webull_api_tokens"("userId");

-- AddForeignKey
ALTER TABLE "webull_api_tokens" ADD CONSTRAINT "webull_api_tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
