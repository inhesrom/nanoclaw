# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser, claude-code, the third-party MCP tool servers (Calendar,
# Gmail, Sheets), and Codex CLI globally. Pre-installing MCPs (vs `npx -y` at spawn)
# avoids a ~16s cold
# download per ephemeral spawn that races past the Agent SDK's MCP-connection window.
# Codex's --json schema and auth.json were verified against codex-cli 0.142.5 (pin
# @openai/codex if a future release drifts). Either runtime runs (NANOCLAW_RUNTIME).
RUN npm install -g agent-browser @anthropic-ai/claude-code @cocal/google-calendar-mcp @gongrzhe/server-gmail-autoauth-mcp google-sheets-mcp @openai/codex

# GitHub official MCP server (Go binary; token-based auth — the onecli-managed
# placeholder PAT is swapped by the credential gateway at api.github.com).
RUN arch="$(uname -m)" && case "$arch" in \
      aarch64|arm64) asset=Linux_arm64 ;; \
      x86_64) asset=Linux_x86_64 ;; \
      *) echo "unsupported arch: $arch" && exit 1 ;; \
    esac \
    && curl -fsSL "https://github.com/github/github-mcp-server/releases/download/v1.5.0/github-mcp-server_${asset}.tar.gz" \
       | tar -xz -C /usr/local/bin github-mcp-server \
    && chmod +x /usr/local/bin/github-mcp-server

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Create entrypoint script
# Container input (prompt, group info) is passed via stdin JSON.
# Credentials are injected by the host's credential proxy — never passed here.
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\ncd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\nln -s /app/node_modules /tmp/dist/node_modules\nchmod -R a-w /tmp/dist\ncat > /tmp/input.json\nnode /tmp/dist/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
