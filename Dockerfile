FROM node:26.12.1-trixie-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec AS node-base

FROM ghcr.io/voidzero-dev/vite-plus:1.4.0@sha256:5dfa2031f7d014b6376407fd99e0747bed329d792c79c184a65ec9a0765bee0e AS vite-plus

FROM mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg

FROM cloudflare/cloudflared:2026.10.3@sha256:faa8e0a1475f137c910be6025f43c8e4092fdd35461b31e19fd1390657a1ff39 AS cloudflared

FROM vite-plus AS builder

WORKDIR /app

COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .nvmrc ./
COPY --chown=vp:vp backend/package.json ./backend/
COPY --chown=vp:vp frontend/package.json ./frontend/
COPY --chown=vp:vp docs/package.json ./docs/
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000 \
    vp install --frozen-lockfile --filter aurral-frontend

COPY --chown=vp:vp frontend/ ./frontend/
COPY --chown=vp:vp lib/ ./lib/
ARG APP_VERSION=unknown
ARG GITHUB_REPO=lklynet/aurral
ARG RELEASE_CHANNEL=stable
ENV VITE_APP_VERSION=$APP_VERSION
ENV VITE_GITHUB_REPO=$GITHUB_REPO
ENV VITE_RELEASE_CHANNEL=$RELEASE_CHANNEL
RUN pnpm --filter aurral-frontend run build

FROM vite-plus AS backend-deps

WORKDIR /app

COPY --chown=vp:vp package.json pnpm-lock.yaml pnpm-workspace.yaml .nvmrc ./
COPY --chown=vp:vp backend/package.json ./backend/
COPY --chown=vp:vp frontend/package.json ./frontend/
COPY --chown=vp:vp docs/package.json ./docs/
RUN --mount=type=cache,target=/home/vp/.local/share/pnpm/store,uid=1000,gid=1000 \
    vp install --frozen-lockfile --prod --filter aurral --filter aurral-backend && \
    cd backend && \
    node -e "require('sharp')" && \
    node --input-type=module -e "import honker from '@russellthehippo/honker-node'; honker.open('/tmp/honker-smoke.db'); console.log('honker ok')"

FROM node-base AS runtime

WORKDIR /app

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    gosu \
    fontconfig \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    python3 \
    ca-certificates \
    libjemalloc2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --shell /usr/sbin/nologin --create-home nodejs \
    && mkdir -p /app/backend/data /config \
    && chown -R nodejs:nodejs /app/backend/data /config

ENV LD_PRELOAD=libjemalloc.so.2 \
    MALLOC_CONF=background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000

COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/

ADD --chmod=755 --checksum=sha256:1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp \
    /usr/local/bin/yt-dlp
RUN yt-dlp --version && ffmpeg -version && ffprobe -version && cloudflared --version

COPY package.json ./
COPY backend/package.json ./backend/
COPY frontend/package.json ./frontend/
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules

COPY backend/ ./backend/
COPY lib/ ./lib/
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --chmod=755 backend/docker-entrypoint.sh /usr/local/bin/

ARG APP_VERSION=unknown
ENV APP_VERSION=$APP_VERSION
ARG GITHUB_REPO=lklynet/aurral
ENV GITHUB_REPO=$GITHUB_REPO

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "backend/server.ts"]
