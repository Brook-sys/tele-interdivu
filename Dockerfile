# syntax=docker/dockerfile:1

# Stage 1 — build the static bundle
# Debian-based (glibc): the rolldown native binding misbehaves on musl (EISDIR)
FROM node:24-slim AS builder

# Build tools for native deps if any appear during npm install
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# The system npm shipped with node 24 images (11.x) breaks on this repo's git
# dependencies (`--before` + `min-release-age` conflict), so pin npm 10
RUN npm i -g npm@10.9.0

COPY package.json package-lock.json ./
# `npm install` (not `ci`): the upstream lock file is not in sync with its
# package.json — the upstream itself installs with `npm i`
RUN npm install --no-audit --no-fund

COPY . .

ARG TELEGRAM_API_ID
ARG TELEGRAM_API_HASH
# These can be dummies — the container-level TELEGRAM_API_ID/TELEGRAM_API_HASH
# environment variables override them at runtime (see deploy/docker-entrypoint.d)
# NOTE: do NOT pass a `BASE_URL` build arg — the upstream build expects either a
# full URL (defaults to web.telegram.org metadata) or unset; a bare "/" breaks it
ENV TELEGRAM_API_ID=$TELEGRAM_API_ID
ENV TELEGRAM_API_HASH=$TELEGRAM_API_HASH

RUN NODE_OPTIONS=--max-old-space-size=4096 npm run build:production
RUN npm run build:server

# Stage 2 — runtime with Node 24 and Nginx
FROM node:24-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends nginx ca-certificates wget \
  && rm -rf /var/lib/apt/lists/* \
  && rm -f /etc/nginx/sites-enabled/default

COPY --from=builder /app/dist /usr/share/nginx/html
COPY --from=builder /app/dist-server /app/server
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 deploy/entrypoint.sh /entrypoint.sh

# Injected at container start by entrypoint.sh (the image itself stays credential-free)
ENV TELEGRAM_API_ID=""
ENV TELEGRAM_API_HASH=""
ENV PROXY_URL=""
ENV AUTOMATION_PORT="3000"
# Orchestration: worker by default; set NODE_ROLE=master on one container only
ENV NODE_ROLE="worker"
ENV MASTER_URL=""
ENV WORKER_ID=""
ENV WORKER_API_URL=""
ENV ORCHESTRATOR_TOKEN=""

VOLUME ["/data"]

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost/ >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/entrypoint.sh"]
