FROM node:22.13-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY src ./src
COPY drizzle ./drizzle
RUN npm run build

FROM mcr.microsoft.com/playwright:v1.61.1-noble AS e2e

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["npm", "run", "test:e2e"]

FROM node:22.13-bookworm-slim AS production-dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22.13-bookworm-slim AS runtime

ENV NODE_ENV=production
ENV DEVKH_GIT_ASKPASS_PATH=/app/scripts/git-askpass.sh
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/lib/devkh/snapshots /var/lib/devkh/repos /var/lib/devkh/uploads /var/lib/devkh/artifacts \
  && mkdir -p /run/devkh-parser \
  && chown -R node:node /app /var/lib/devkh /run/devkh-parser

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node --chmod=755 scripts/git-askpass.sh ./scripts/git-askpass.sh

USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

CMD ["node", "dist/server/server/main.js"]

FROM runtime AS integration

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/tsconfig.json /app/tsconfig.node.json /app/vite.config.ts ./
