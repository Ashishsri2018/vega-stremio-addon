# syntax=docker/dockerfile:1

# Optional baseline provider snapshot. Pass --build-arg PROVIDER_SHA=<commit> to
# bake Zenda-Cross/vega-providers into the image; the entrypoint seeds it into an
# empty DATA_DIR so fresh containers do not need GitHub at startup. The default is
# empty so CI builds do not need network access. Review the upstream license
# before distributing an image that contains provider code.
FROM node:22-bookworm-slim AS providers
ARG PROVIDER_SHA=""
ARG PROVIDER_SOURCE="Zenda-Cross/vega-providers"
WORKDIR /app
COPY scripts/fetch-provider-snapshot.mjs ./scripts/
RUN owner="${PROVIDER_SOURCE%%/*}" \
    && if [ -n "$PROVIDER_SHA" ]; then \
         node scripts/fetch-provider-snapshot.mjs \
           --sha "$PROVIDER_SHA" \
           --source "$PROVIDER_SOURCE" \
           --out "/providers-baseline/$owner"; \
       else \
         mkdir -p "/providers-baseline/$owner"; \
       fi

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
COPY --from=providers /providers-baseline ./providers-baseline
COPY deploy/beamup.env ./deploy/beamup.env
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
