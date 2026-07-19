-- Webull token persistence + optional account id.
-- webull_api_tokens becomes per-(user, environment) like webull_credentials;
-- encAccountId becomes nullable (discovered via GET /openapi/account/list).

-- DropIndex
DROP INDEX "webull_api_tokens_userId_key";

-- AlterTable
ALTER TABLE "webull_api_tokens" ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'live';

-- AlterTable
ALTER TABLE "webull_credentials" ALTER COLUMN "encAccountId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "webull_api_tokens_userId_environment_key" ON "webull_api_tokens"("userId", "environment");
