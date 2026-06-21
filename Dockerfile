# syntax=docker/dockerfile:1

# ---- Stage 1: build ----------------------------------------------------------
# Compile TypeScript -> dist/ and copy data/ -> dist/data/. Needs devDeps (tsc).
FROM node:20-alpine AS build
WORKDIR /app

# Install ALL deps (incl. devDeps) against the lockfile for a reproducible build.
COPY package.json package-lock.json ./
RUN npm ci

# Build inputs only (keeps the layer cache from busting on unrelated changes).
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
COPY data ./data
RUN npm run build

# ---- Stage 2: runtime --------------------------------------------------------
# Ship only production deps + the compiled, self-contained dist/ (which already
# contains dist/data via copy-data.mjs). No source, no tsc, no devDeps.
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Production dependencies only.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Compiled output (includes dist/data/simpro-api-index.json).
COPY --from=build /app/dist ./dist

ENV SIMPRO_TRANSPORT=broker
ENV PORT=3000
EXPOSE 3000

# /data holds the auto-generated broker seal key; a fresh named volume inherits
# this dir's ownership, so the non-root `node` user can write to it.
RUN mkdir -p /data && chown node:node /data

# Run as the built-in non-root `node` user.
USER node

# A tiny inline healthcheck against /healthz (no curl/wget in the base image).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3000,path:'/healthz'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
