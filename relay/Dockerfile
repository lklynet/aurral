FROM node:26-alpine

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY relay/package.json ./relay/package.json
COPY lib ./lib
COPY relay/src ./relay/src

RUN corepack enable && pnpm --filter aurral-relay install --frozen-lockfile --prod

ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

EXPOSE 8080

CMD ["node", "relay/src/server.ts"]
