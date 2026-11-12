# syntax=docker/dockerfile:1
#
# The router is the data path: every project is unreachable while it is down.
# It ships as its own image, separate from the control plane, so that
# restarting or upgrading the control plane does not interrupt live database
# connections — and so it can be replaced with a compiled implementation later
# without touching anything else.

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS prod-deps
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
    pnpm install --frozen-lockfile --prod --filter @justpostgres/router...

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
RUN pnpm --filter @justpostgres/router build

FROM base AS runtime
# Stamped by the release workflow, so the UI footer and logs say what is running.
ARG JP_VERSION=0.0.0-dev
ENV NODE_ENV=production \
    JP_VERSION=${JP_VERSION} \
    JP_DATA_DIR=/data \
    JP_ROUTER_SESSION_PORT=5432 \
    JP_ROUTER_POOL_PORT=6543

RUN apt-get update \
 && apt-get install -y --no-install-recommends tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Same layout rule as the control plane: pnpm's node_modules is relative
# symlinks into the root store, and Node's ESM resolver ignores NODE_PATH.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/router/node_modules ./apps/router/node_modules
COPY --from=build /app/packages/secrets ./packages/secrets
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/apps/router/dist ./apps/router/dist

WORKDIR /app/apps/router
USER node
EXPOSE 5432 6543

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
