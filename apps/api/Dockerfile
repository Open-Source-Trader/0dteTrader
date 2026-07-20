# ---- Stage 1: build ----
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

# Copy workspace structure (cache-friendly layer for npm ci)
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared-types/package.json packages/shared-types/

# Prisma schema must be present before npm ci (postinstall runs prisma generate)
COPY apps/api/prisma/ apps/api/prisma/

RUN npm ci

# Build shared-types
COPY packages/shared-types/ packages/shared-types/
RUN npm run build --workspace packages/shared-types

# Build API
COPY apps/api/src/ apps/api/src/
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
RUN npm run build --workspace apps/api

# Prune to production dependencies (avoids re-triggering lifecycle scripts)
RUN npm prune --omit=dev

# ---- Stage 2: production ----
FROM node:22-alpine

RUN apk add --no-cache tini openssl

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared-types/dist ./packages/shared-types/dist
COPY --from=builder /app/packages/shared-types/package.json ./packages/shared-types/
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/apps/api/package.json ./apps/api/
COPY --from=builder /app/package.json ./

RUN addgroup -S appgroup && adduser -S appuser -G appgroup
USER appuser

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["sh", "-c", "npx prisma migrate deploy --schema apps/api/prisma/schema.prisma && node apps/api/dist/main.js"]
