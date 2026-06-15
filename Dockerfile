FROM node:26-bookworm-slim AS builder

WORKDIR /app

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
RUN npm ci --workspace frontend --include-workspace-root=false

COPY frontend/ ./frontend/
COPY lib/ ./lib/
ARG APP_VERSION=unknown
ARG GITHUB_REPO=lklynet/aurral
ARG RELEASE_CHANNEL=stable
ENV VITE_APP_VERSION=$APP_VERSION
ENV VITE_GITHUB_REPO=$GITHUB_REPO
ENV VITE_RELEASE_CHANNEL=$RELEASE_CHANNEL
RUN npm run build --workspace frontend

FROM node:26-bookworm-slim
ARG APP_VERSION=unknown
ENV APP_VERSION=$APP_VERSION

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gosu \
    fontconfig \
    fonts-dejavu-core \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1001 nodejs \
    && useradd --uid 1001 --gid nodejs --shell /usr/sbin/nologin --create-home nodejs \
    && mkdir -p /app/backend/data /config \
    && chown -R nodejs:nodejs /app

COPY package*.json ./
COPY backend/package*.json ./backend/
COPY frontend/package*.json ./frontend/
RUN npm ci --workspace backend --omit=dev --include=optional --include-workspace-root=false && \
    node -e "require('sharp')" && \
    node --input-type=module -e "import honker from '@russellthehippo/honker-node'; honker.open('/tmp/honker-smoke.db'); console.log('honker ok')"

COPY backend/ ./backend/
COPY lib/ ./lib/
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY backend/docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    chown -R nodejs:nodejs /app

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "backend/server.js"]
