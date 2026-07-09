FROM node:22-slim AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package.json
COPY scripts/patch-flue-runtime-abort.mjs scripts/patch-flue-runtime-abort.mjs
COPY scripts/patch-flue-prepare-arguments.mjs scripts/patch-flue-prepare-arguments.mjs
RUN npm install

COPY . .
RUN npm run build

FROM node:22-bookworm AS runtime

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    git \
    ripgrep \
    tini \
    gosu \
    python3 \
    python-is-python3 \
    python3-venv \
    python3-pip \
    build-essential \
    cmake \
    pkg-config \
    make \
    gcc \
    g++ \
    unzip \
    jq \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home --shell /bin/bash threadcord \
  && mkdir -p /workspaces \
  && chown -R threadcord:threadcord /workspaces /app

COPY package.json package.json
COPY scripts/patch-flue-runtime-abort.mjs scripts/patch-flue-runtime-abort.mjs
COPY scripts/patch-flue-prepare-arguments.mjs scripts/patch-flue-prepare-arguments.mjs
RUN npm install --omit=dev

COPY --from=build /app/dist ./dist
COPY vendor/tree-sitter ./vendor/tree-sitter
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3583
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.mjs"]
