# syntax=docker/dockerfile:1
# Production image for Dokploy (build context: microfinance-app/).
# Secrets are NOT baked in: DATABASE_URL, JWT_SECRET, INTERNAL_API_KEY, ADMIN_EMAIL, SMTP_*
# are read from the container environment at runtime. See docs/DEPLOY.md.

ARG NODE_IMAGE=node:22-slim

# ---- deps: install all packages from the lockfile ----
FROM ${NODE_IMAGE} AS deps
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# ---- build: generate the Prisma client and build the standalone server ----
FROM ${NODE_IMAGE} AS build
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1
# Placeholder, only so code that reads DATABASE_URL during the build does not crash.
# It stays in this stage; the runner gets the real value from the environment.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npx next build

# ---- runner: minimal runtime ----
FROM ${NODE_IMAGE} AS runner
RUN apt-get update -y \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN chown node:node /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    CHECKPOINT_DISABLE=1 \
    PRISMA_HIDE_UPDATE_MESSAGE=1 \
    PORT=3001 \
    HOSTNAME=0.0.0.0

# Standalone server (traced node_modules, including @prisma/client and the query engine)
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
# Schema + migrations, and the Prisma CLI for `migrate deploy` (not part of standalone tracing)
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/node_modules/prisma ./node_modules/prisma
COPY --from=build --chown=node:node /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build --chown=node:node /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build --chown=node:node /app/node_modules/jiti ./node_modules/jiti

USER node
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3001/api/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Apply pending migrations; the server starts only if that succeeds.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy --schema prisma/schema.prisma && exec node server.js"]
