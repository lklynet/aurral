FROM node:20-alpine AS builder

WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/ ./
ARG APP_VERSION=unknown
ARG GITHUB_REPO=lklynet/aurral
ARG RELEASE_CHANNEL=stable
ENV VITE_APP_VERSION=$APP_VERSION
ENV VITE_GITHUB_REPO=$GITHUB_REPO
ENV VITE_RELEASE_CHANNEL=$RELEASE_CHANNEL
RUN npm run build

FROM node:20-alpine
ARG APP_VERSION=unknown
ENV APP_VERSION=$APP_VERSION

WORKDIR /app

RUN apk add --no-cache su-exec fontconfig ttf-dejavu && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    mkdir -p /app/backend/data && \
    chown -R nodejs:nodejs /app

COPY backend/package*.json ./backend/
RUN apk add --no-cache python3 make g++ && cd backend && npm ci --omit=dev

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY backend/ ./backend/
COPY server.js loadEnv.js ./
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY backend/docker-entrypoint.sh /usr/local/bin/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh && \
    chown -R nodejs:nodejs /app

EXPOSE 3001

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]
