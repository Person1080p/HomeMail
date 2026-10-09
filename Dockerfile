# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS build
WORKDIR /app
# Toolchain only needed if better-sqlite3 has no prebuilt binary for the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build \
 && npm prune --omit=dev \
 && rm -rf server/src web/src web/node_modules web/public

FROM node:24-bookworm-slim
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/dist/index.js"]
