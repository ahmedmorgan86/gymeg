FROM node:22-bookworm-slim

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      ca-certificates \
      fonts-liberation \
      fonts-noto-color-emoji \
      git \
      wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/wpp-server

RUN git clone --depth 1 --branch v2.10.99 https://github.com/wppconnect-team/wppconnect-server.git . \
    && npm install --legacy-peer-deps \
    && npm run build \
    && npm prune --omit=dev \
    && npm cache clean --force

COPY apply-wpp-patches.mjs /tmp/apply-wpp-patches.mjs
RUN node /tmp/apply-wpp-patches.mjs /usr/src/wpp-server && rm -f /tmp/apply-wpp-patches.mjs

EXPOSE 21465
CMD ["node", "dist/server.js"]
