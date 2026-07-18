-- DropIndex
DROP INDEX "webull_credentials_userId_key";

-- AlterTable
ALTER TABLE "trade_orders" ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'live';

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "tradingMode" TEXT NOT NULL DEFAULT 'live';

-- AlterTable
ALTER TABLE "webull_credentials" ADD COLUMN     "environment" TEXT NOT NULL DEFAULT 'live';

-- CreateIndex
CREATE UNIQUE INDEX "webull_credentials_userId_environment_key" ON "webull_credentials"("userId", "environment");
