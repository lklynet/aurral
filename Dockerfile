FROM node:26.13.1-trixie-slim@sha256:abe7e5a82b61a8ef67b315b85497c9e65173387ccf2f4a029248184b8e020be5 AS node-base

FROM ghcr.io/voidzero-dev/vite-plus:1.8.0@sha256:648c4e90a1da9f9376ff869e9c1f823faeabc953a0213a67748bbdbdf90b31ae AS vite-plus

FROM mwader/static-ffmpeg:9.1@sha256:dd09509d8c2152bfa601c8c20e3dd166bde906d37951b9f7e8bbd922267f5ac9 AS ffmpeg

FROM cloudflare/cloudflared:2026.11.2@sha256:55c7e3e8d89d5e8d20b75a82f3602cbf98e06db406e73e282073cfdc5a9a3af6 AS cloudflared

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
    node -e "require('sharp')"

FROM node-base AS runtime

WORKDIR /app

RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    fontconfig \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    python3 \
    ca-certificates \
    libjemalloc2 \
    tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --shell /usr/sbin/nologin --create-home nodejs \
    && mkdir -p /config \
    && chown -R nodejs:nodejs /config

ENV LD_PRELOAD=libjemalloc.so.2 \
    MALLOC_CONF=background_thread:true,dirty_decay_ms:1000,muzzy_decay_ms:1000

COPY --from=ffmpeg /ffmpeg /ffprobe /usr/local/bin/
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/

ADD --chmod=755 --checksum=sha256:e8665ed64d6b9172773e812f891fb707a0cb1ee8d9ef4fc1acb00cabee4c5256 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.11.23/yt-dlp \
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

ENTRYPOINT ["tini", "-s", "--", "docker-entrypoint.sh"]
CMD ["node", "--max-semi-space-size=4", "backend/server.ts"]
