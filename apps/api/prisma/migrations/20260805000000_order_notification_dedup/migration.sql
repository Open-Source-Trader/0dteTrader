CREATE TABLE "order_notifications" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_notifications_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "order_notifications_userId_orderId_status_key"
  ON "order_notifications"("userId", "orderId", "status");

ALTER TABLE "order_notifications"
  ADD CONSTRAINT "order_notifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
