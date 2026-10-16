FROM node:24-bookworm AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts ./
COPY shared ./shared
COPY server ./server
COPY client ./client
RUN npm run build

FROM build AS runtime-dependencies
COPY docker/runtime-dependencies.mjs /tmp/runtime-dependencies.mjs
RUN node /tmp/runtime-dependencies.mjs \
    && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY --from=runtime-dependencies /app/package*.json ./
COPY --from=runtime-dependencies /app/node_modules ./node_modules
RUN npx playwright install --with-deps chromium --only-shell \
    && apt-get update && apt-get install -y --no-install-recommends iptables gosu \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/dist ./dist
COPY docker/entrypoint.sh /usr/local/bin/pagesentinel-entrypoint
RUN chmod 755 /usr/local/bin/pagesentinel-entrypoint && mkdir -p /app/data && chown node:node /app/data
EXPOSE 3000
ENTRYPOINT ["pagesentinel-entrypoint"]
CMD ["node", "dist/server/server/src/index.js"]
