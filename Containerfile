ARG NODE_IMAGE=docker.io/library/node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

FROM ${NODE_IMAGE} AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.source=https://github.com/hoolia/exact-online-mcp \
      org.opencontainers.image.description="Remote MCP server for Exact Online with its own OAuth 2.1 broker" \
      org.opencontainers.image.licenses=NOASSERTION
ENV NODE_ENV=production DB_PATH=/data/connector.db
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY migrations ./migrations
# any UID in group 0 (OpenShift restricted SCC) may write the data directory; mount a volume there
RUN mkdir /data && chgrp 0 /data && chmod 0775 /data
VOLUME /data
USER 1000
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
