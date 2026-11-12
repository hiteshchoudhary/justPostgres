# syntax=docker/dockerfile:1
#
# The control plane and the web UI ship as one image: the API server serves the
# built SPA from the same origin, so there is no CORS story and no second
# container to operate.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app


# --- production dependencies ------------------------------------------------
# Built in its own stage so the toolchain needed to compile better-sqlite3
# never reaches the runtime image.
FROM base AS prod-deps
# Every workspace member's package.json, not just the ones this image runs.
# pnpm resolves `workspace:*` against the whole workspace, so a missing
# manifest fails `--frozen-lockfile` — and only on a cold cache, which is why
# this passed locally for weeks and failed the first time CI built it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/secrets/package.json packages/secrets/
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/router/package.json apps/router/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter @justpostgres/control-plane...


# --- build ------------------------------------------------------------------
FROM base AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/secrets/package.json packages/secrets/
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/router/package.json apps/router/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY . .
# Vite writes the UI into apps/control-plane/public; tsup bundles the server,
# inlining @justpostgres/shared so the runtime image needs no workspace links.
RUN pnpm build


# --- runtime ----------------------------------------------------------------
FROM base AS runtime
# Stamped by the release workflow, so the UI footer and logs say what is running.
ARG JP_VERSION=0.0.0-dev
ENV NODE_ENV=production \
    JP_VERSION=${JP_VERSION} \
    JP_DATA_DIR=/data \
    JP_UI_DIR=/app/apps/control-plane/public \
    JP_SERVE_UI=true \
    JP_PORT=3000

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# The runtime mirrors the workspace layout exactly, and that is load-bearing.
# pnpm's node_modules is a tree of relative symlinks into the root .pnpm store,
# so moving either half breaks every link. Node's ESM resolver also walks up
# from the importing file and — unlike CommonJS — ignores NODE_PATH entirely,
# so the only thing that makes `import "hono"` resolve from
# /app/apps/control-plane/dist/index.js is finding node_modules where pnpm
# actually put it.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/control-plane/node_modules ./apps/control-plane/node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/control-plane/dist ./apps/control-plane/dist
COPY --from=build /app/apps/control-plane/drizzle ./apps/control-plane/drizzle
COPY --from=build /app/apps/control-plane/public ./apps/control-plane/public

WORKDIR /app/apps/control-plane

RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.JP_PORT||3000)+'/api/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM, which is what triggers the graceful
# job-lease release on shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
