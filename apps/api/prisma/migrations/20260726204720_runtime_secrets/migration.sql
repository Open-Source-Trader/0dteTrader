-- CreateTable
CREATE TABLE "runtime_secrets" (
    "name" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "runtime_secrets_pkey" PRIMARY KEY ("name")
);
