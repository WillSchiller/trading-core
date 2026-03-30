# --- Rust: Polymarket RTDS → CLOB hot path (no Node on this path) ---
FROM rust:1.88-bookworm AS rust-hotpath

WORKDIR /build
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config \
    cmake \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

COPY pm-copy-hotpath/Cargo.toml pm-copy-hotpath/Cargo.lock ./
COPY pm-copy-hotpath/src ./src
COPY pm-copy-hotpath/benches ./benches

RUN cargo build --locked --release

# --- Node app (existing) ---
FROM node:20-slim AS builder

WORKDIR /build

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY config ./config
COPY sql ./sql

RUN npm run build

# Production dependencies stage
FROM node:20-slim AS deps

WORKDIR /deps
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Production stage
FROM node:20-slim

ARG GIT_SHA=unknown
ENV NODE_ENV=production
ENV GIT_SHA=$GIT_SHA

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g tsx

RUN groupadd -r trader && \
    useradd -r -g trader -u 1001 trader

WORKDIR /app

COPY --from=deps --chown=trader:trader /deps/node_modules ./node_modules
COPY --from=builder --chown=trader:trader /build/dist ./dist
COPY --from=builder --chown=trader:trader /build/package*.json ./
COPY --chown=trader:trader config ./config
COPY --chown=trader:trader sql ./sql
COPY --chown=trader:trader scripts ./scripts
COPY --chown=trader:trader models ./models

USER root
COPY --from=rust-hotpath --chmod=755 /build/target/release/pm-copy-hotpath /usr/local/bin/pm-copy-hotpath
COPY --chown=trader:trader pm-copy-hotpath/pm-hotpath.toml /app/pm-hotpath/pm-hotpath.toml
USER trader

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

CMD ["node", "dist/index.js"]
