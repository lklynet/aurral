FROM node:26.5.1-bookworm-slim@sha256:9e6f9357d371591e32ab6f2d8a26d63bdd0d17c29eee3f4f3e7e454d9634bf73 AS node-base

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

ADD --chmod=755 --checksum=sha256:1fa6733c37ea6fb51c99ad8fe785e7b7e5f3246c9b980230329d4fb72ed8d4d6 \
    https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp \
    /usr/local/bin/yt-dlp
RUN yt-dlp --version

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
COPY --from=backend-deps /app/node_modules ./node_modules
COPY --from=backend-deps /app/backend/node_modules ./backend/node_modules

COPY backend/ ./backend/
COPY lib/ ./lib/
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --chmod=755 backend/docker-entrypoint.sh /usr/local/bin/

ARG APP_VERSION=unknown
ENV APP_VERSION=$APP_VERSION

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "backend/server.js"]
