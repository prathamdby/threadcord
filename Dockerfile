FROM node:22-bookworm AS build

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-bookworm AS runtime

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    file \
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

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Verify the AgentOS sidecar binary is present and executable for the target
# platform. This fails the build early if the wrong platform package is installed.
RUN node -e "const { getSidecarPath } = require('@rivet-dev/agentos-sidecar'); const path = getSidecarPath(); const fs = require('fs'); fs.accessSync(path, fs.constants.X_OK); console.log('sidecar ready:', path);"

ENV NODE_ENV=production
ENV PORT=3583
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
