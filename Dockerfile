FROM node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb AS node-base

FROM node-base AS builder

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace frontend --include-workspace-root=false

COPY frontend/ ./frontend/
COPY lib/ ./lib/
ARG APP_VERSION=unknown
ARG GITHUB_REPO=lklynet/aurral
ARG RELEASE_CHANNEL=stable
ENV VITE_APP_VERSION=$APP_VERSION
ENV VITE_GITHUB_REPO=$GITHUB_REPO
ENV VITE_RELEASE_CHANNEL=$RELEASE_CHANNEL
RUN npm run build --workspace frontend

FROM node-base AS backend-deps

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY backend/scripts/patchHonkerAbortListener.js ./backend/scripts/patchHonkerAbortListener.js
COPY frontend/package*.json ./frontend/
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --workspace backend --omit=dev --include=optional --include-workspace-root=false && \
    node -e "require('sharp')" && \
    node --input-type=module -e "import honker from '@russellthehippo/honker-node'; honker.open('/tmp/honker-smoke.db'); console.log('honker ok')"

FROM node-base AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    fontconfig \
    fonts-dejavu-core \
    fonts-noto-color-emoji \
    python3 \
    ffmpeg \
    ca-certificates \
    libjemalloc2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --shell /usr/sbin/nologin --create-home nodejs \
    && mkdir -p /app/backend/data /config \
    && chown -R nodejs:nodejs /app/backend/data /config

ENV LD_PRELOAD=libjemalloc.so.2

ADD --chmod=755 --checksum=sha256:e5d57466682cfa9d61e9cf7c8a4f09b00f4a62af37d3bbdc4bcffdf63615feac \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.06.09/yt-dlp \
    /usr/local/bin/yt-dlp
RUN yt-dlp --version

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

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "backend/server.js"]
