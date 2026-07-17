FROM mcr.microsoft.com/playwright:v1.61.1-noble

ENV NODE_ENV=production \
    TZ=Asia/Seoul

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json tsconfig.eslint.json eslint.config.mjs ./
COPY src ./src
COPY assets ./assets
COPY scripts/docker-entrypoint.sh /usr/local/bin/kb-bank-sync-entrypoint
RUN npm run build && npm prune --omit=dev

RUN command -v xvfb-run >/dev/null \
    && chmod 0755 /usr/local/bin/kb-bank-sync-entrypoint \
    && mkdir -p /app/logs /app/output \
    && chown -R pwuser:pwuser /app
USER pwuser

ENTRYPOINT ["kb-bank-sync-entrypoint"]
