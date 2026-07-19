# ---- Stage 1: build ----
FROM node:18-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy workspace structure (cache-friendly layer for npm ci)
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared-types/package.json packages/shared-types/

RUN npm ci

# Build shared-types
COPY packages/shared-types/ packages/shared-types/
RUN npm run build --workspace packages/shared-types

# Generate Prisma client
COPY apps/api/prisma/ apps/api/prisma/
RUN npx --workspace apps/api prisma generate

# Build API
COPY apps/api/src/ apps/api/src/
COPY apps/api/tsconfig.json apps/api/tsconfig.build.json apps/api/
RUN npm run build --workspace apps/api

# Prune to production dependencies
RUN npm ci --omit=dev && npx --workspace apps/api prisma generate

# ---- Stage 2: production ----
FROM node:18-alpine

RUN apk add --no-cache tini

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
CMD ["node", "apps/api/dist/main.js"]
