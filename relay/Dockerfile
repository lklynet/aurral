FROM node:26-alpine AS deps

WORKDIR /app

RUN npm install -g pnpm@10

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY relay/package.json ./relay/package.json

RUN pnpm --filter aurral-relay install --frozen-lockfile --prod

FROM node:26-alpine

WORKDIR /app

COPY --from=deps /app/package.json ./package.json
COPY --from=deps /app/relay/package.json ./relay/package.json
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/relay/node_modules ./relay/node_modules
COPY lib ./lib
COPY relay/src ./relay/src

USER node

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "relay/src/server.ts"]
