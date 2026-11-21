# syntax=docker/dockerfile:1.7
#
# Bibliolisa – Single-Container-Image (API + Webapp), Multi-Stage-Build.
#   shared -> web (Vite) & server (tsc) -> schlanke Runtime ohne Dev-Abhängigkeiten.
# Es wird KEIN Reverse Proxy gebündelt; der Host-Proxy spricht http://<host>:3000 an.

ARG NODE_VERSION=22

# ---------------------------------------------------------------------------
# Basis: Node 22 (Debian/glibc, damit better-sqlite3 & sharp Prebuilds auf amd64/arm64 laufen)
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------------------
# Stage 1: builder – installiert alle Workspaces und baut shared -> web -> server
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS builder
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
# Fallback-Toolchain, falls für eine Plattform kein Prebuild von better-sqlite3 existiert.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY mobile/package.json mobile/package.json
RUN --mount=type=cache,id=pnpm-store-builder,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "@bibliolisa/shared..." --filter "@bibliolisa/server..." --filter "@bibliolisa/web..."

COPY shared ./shared
COPY server ./server
COPY web ./web
RUN pnpm --filter @bibliolisa/shared build \
    && pnpm --filter @bibliolisa/web build \
    && pnpm --filter @bibliolisa/server build

# ---------------------------------------------------------------------------
# Stage 2: prod-deps – ausschließlich Produktionsabhängigkeiten des Servers
# ---------------------------------------------------------------------------
FROM base AS prod-deps
ARG TARGETARCH
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json shared/package.json
COPY server/package.json server/package.json
COPY web/package.json web/package.json
COPY mobile/package.json mobile/package.json
RUN --mount=type=cache,id=pnpm-store-${TARGETARCH},target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter "@bibliolisa/server..." \
    && rm -rf mobile

# ---------------------------------------------------------------------------
# Stage 3: runtime – Non-Root (UID/GID 10001), nur Prod-Dependencies + Build-Artefakte
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS runtime

ARG APP_UID=10001
ARG APP_GID=10001

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data \
    WEB_DIR=/app/public \
    TRUST_PROXY=true

# Unprivilegierter Benutzer + persistentes Datenverzeichnis (DB + Cover-Cache) mit passenden Rechten.
# Ein Named Volume übernimmt diese Besitzverhältnisse beim ersten Start automatisch.
RUN groupadd --system --gid ${APP_GID} bibliolisa \
    && useradd --system --uid ${APP_UID} --gid ${APP_GID} --no-create-home \
        --home-dir /nonexistent --shell /usr/sbin/nologin bibliolisa \
    && mkdir -p /data/covers \
    && chown -R ${APP_UID}:${APP_GID} /data \
    && chmod 750 /data

WORKDIR /app

# Prod-node_modules inkl. pnpm-Workspace-Symlinks (server -> shared) + package.json-Dateien
COPY --from=prod-deps /app/ ./
# Build-Artefakte
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/web/dist ./public

COPY docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh \
    && chmod 755 /usr/local/bin/docker-entrypoint.sh

VOLUME ["/data"]
EXPOSE 3000

USER ${APP_UID}:${APP_GID}

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/dist/index.js"]
