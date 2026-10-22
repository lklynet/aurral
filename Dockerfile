FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS node-base

FROM ghcr.io/voidzero-dev/vite-plus:1.3.0@sha256:61860c1b58bf35878605280802809973c668f1594675298c3be553a98ac06e59 AS vite-plus

FROM mwader/static-ffmpeg:9.0.2@sha256:7d9bdaaf887f7e6ce6151f67325c344074b5ff1fb75316011c3376503e449a7b AS ffmpeg

FROM cloudflare/cloudflared:2026.10.1@sha256:a15a3b50b8dabd57ac2090e9484c0247dba9dfa1f0df4d298d4317f9d69eb2d5 AS cloudflared

FROM vite-plus AS builder

WORKDIR /app

COPY --chown=vp:vp package*.json .npmrc .nvmrc ./
COPY --chown=vp:vp backend/package*.json ./backend/
COPY --chown=vp:vp frontend/package*.json ./frontend/
RUN --mount=type=cache,target=/home/vp/.npm,uid=1000,gid=1000,sharing=locked \
    vp install --frozen-lockfile --filter frontend

COPY --chown=vp:vp frontend/ ./frontend/
COPY --chown=vp:vp lib/ ./lib/
ARG APP_VERSION=unknown
ARG GITHUB_REPO=lklynet/aurral
ARG RELEASE_CHANNEL=stable
ENV VITE_APP_VERSION=$APP_VERSION
ENV VITE_GITHUB_REPO=$GITHUB_REPO
ENV VITE_RELEASE_CHANNEL=$RELEASE_CHANNEL
RUN vp run build

FROM vite-plus AS backend-deps

WORKDIR /app

COPY --chown=vp:vp package*.json .npmrc .nvmrc ./
COPY --chown=vp:vp backend/package*.json ./backend/
COPY --chown=vp:vp frontend/package*.json ./frontend/
RUN --mount=type=cache,target=/home/vp/.npm,uid=1000,gid=1000,sharing=locked \
    vp install --frozen-lockfile --prod --filter backend && \
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

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
COPY --from=backend-deps /app/node_modules ./node_modules

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
