# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=7000 \
    DATA_DIR=/data \
    TMPDIR=/tmp \
    HOME=/tmp
RUN apt-get update \
    && apt-get install -y --no-install-recommends dumb-init gosu \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 755 /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data \
    && chown -R node:node /data
EXPOSE 7000
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
