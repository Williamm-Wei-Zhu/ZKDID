FROM node:20-alpine

WORKDIR /app

# Install prod deps in its own layer
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Copy source
COPY server.mjs ./
# config.json is NOT baked in — provide via volume or env
COPY config.json.example ./config.json.example

EXPOSE 7000
ENV PORT=7000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:7000/healthz || exit 1

CMD ["node", "server.mjs"]
