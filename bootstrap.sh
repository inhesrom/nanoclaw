#!/usr/bin/env bash
#
# bootstrap.sh — One-command fresh install for a NanoClaw fork.
#
# Takes a clean clone to a running service. Handles the pre-toolchain phase
# that must run before any Node/TypeScript is guaranteed to work (git remotes,
# Node, dependencies, Docker), then hands off to the TypeScript orchestrator
# (`setup/index.ts --step bootstrap`) for everything else.
#
# Interactive by default; pass --non-interactive for headless provisioning
# (secrets via NANOCLAW_ANTHROPIC_SECRET; WhatsApp QR still cannot be scripted).
#
# All flags are forwarded to the orchestrator. See docs/BOOTSTRAP.md.
#
# Exit codes: 0 success · 1 step failure · 2 missing prerequisite ·
#             5 gate unmet in --non-interactive mode
set -u

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"

UPSTREAM_URL="https://github.com/qwibitai/nanoclaw.git"

# --- Parse the flags this script cares about (all are also forwarded) --------
NON_INTERACTIVE="false"
RUNTIME="docker"
args=("$@")
for i in "${!args[@]}"; do
  case "${args[$i]}" in
    --non-interactive) NON_INTERACTIVE="true" ;;
    --runtime) RUNTIME="${args[$((i + 1))]:-docker}" ;;
  esac
done

say() { printf '%s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
die() {
  printf '✗ %s\n' "$2" >&2
  exit "$1"
}

# Prompt helper: returns 0 for yes. Auto-yes default, but never blocks in
# --non-interactive mode (returns 1 = no).
confirm() {
  local prompt="$1"
  if [ "$NON_INTERACTIVE" = "true" ]; then return 1; fi
  local reply
  read -r -p "$prompt [Y/n] " reply
  case "$reply" in
    [nN] | [nN][oO]) return 1 ;;
    *) return 0 ;;
  esac
}

say ""
say "=== NanoClaw bootstrap ==="
say ""

# --- Apple Container is not handled here -------------------------------------
if [ "$RUNTIME" = "apple-container" ]; then
  die 2 "Apple Container isn't supported by bootstrap.sh (it does Docker-specific
  setup). Use the /setup skill with /convert-to-apple-container instead."
fi

# --- 1. Git remotes (advisory, never blocking) ------------------------------
if command -v git >/dev/null 2>&1 && [ -d .git ]; then
  if ! git remote get-url upstream >/dev/null 2>&1; then
    git remote add upstream "$UPSTREAM_URL" 2>/dev/null &&
      say "› Added 'upstream' remote → $UPSTREAM_URL"
  fi
  origin_url="$(git remote get-url origin 2>/dev/null || true)"
  case "$origin_url" in
    *qwibitai/nanoclaw*)
      warn "origin points at the canonical repo (qwibitai/nanoclaw)."
      warn "Fork it on GitHub and 'git remote set-url origin <your-fork>' so your"
      warn "customizations have a home. Continuing anyway."
      ;;
  esac
fi

# --- 2. Node + dependencies -------------------------------------------------
# Skip the (multi-minute, DESTRUCTIVE) `npm ci` when deps already work: the
# native module loading is the authoritative "install is functional" signal.
# `npm ci` wipes node_modules before reinstalling, so never run it against a
# working tree — a mid-install failure (e.g. a locked-down registry) would
# leave the install broken. Trust the runtime check, not lockfile mtimes
# (some installs have no node_modules/.package-lock.json marker at all).
deps_current() {
  # Open an in-memory DB, not just require() — better-sqlite3's JS loads fine
  # even when its native .node binary is missing; only constructing a Database
  # exercises the binding. This is the true "install is functional" signal.
  [ -d node_modules ] &&
    node -e "new (require('better-sqlite3'))(':memory:')" >/dev/null 2>&1
}

run_setup_sh() {
  bash "$PROJECT_ROOT/setup.sh"
}

install_node_via_nvm() {
  say "› Installing nvm and Node (from .nvmrc)..."
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash ||
    return 1
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
  nvm install || return 1 # reads .nvmrc (Node 22)
  nvm use || return 1
}

if deps_current; then
  say "› Dependencies already current — skipping npm ci."
else
  say "› Installing dependencies (bash setup.sh)..."
  if run_setup_sh; then
    :
  else
    rc=$?
    if [ "$rc" -eq 2 ]; then
      # Node missing or < 20
      if [ -f "$HOME/.nvm/nvm.sh" ] || confirm "Node >=20 not found. Install Node 22 via nvm?"; then
        if install_node_via_nvm && run_setup_sh; then
          :
        else
          die 2 "Node install or dependency setup failed. See logs/setup.log."
        fi
      else
        die 2 "Node >=20 is required. Install it (https://nodejs.org or nvm) and re-run."
      fi
    else
      die 1 "Dependency setup failed (exit $rc). See logs/setup.log."
    fi
  fi
fi

# --- 3. Docker gate ---------------------------------------------------------
docker_running() { docker info >/dev/null 2>&1; }

start_docker() {
  local uname_s
  uname_s="$(uname -s)"
  if [ "$uname_s" = "Darwin" ]; then
    open -a Docker >/dev/null 2>&1 || return 1
    say "› Starting Docker Desktop (waiting up to 60s)..."
    for _ in $(seq 1 60); do
      docker_running && return 0
      sleep 1
    done
    return 1
  fi
  # Linux
  sudo systemctl start docker >/dev/null 2>&1 || return 1
  for _ in $(seq 1 15); do
    docker_running && return 0
    sleep 1
  done
  return 1
}

install_docker() {
  say "› Installing Docker (get.docker.com)..."
  curl -fsSL https://get.docker.com | sh || return 1
  if [ "$(uname -s)" = "Linux" ]; then
    sudo usermod -aG docker "$USER" >/dev/null 2>&1 || true
    # New group membership won't apply to this shell; grant socket access now so
    # the rest of bootstrap works without a re-login.
    sudo setfacl -m "u:$USER:rw" /var/run/docker.sock >/dev/null 2>&1 || true
    sudo systemctl enable --now docker >/dev/null 2>&1 || true
  fi
}

if docker_running; then
  say "› Docker is running."
else
  if command -v docker >/dev/null 2>&1; then
    say "› Docker is installed but not running — starting it..."
    start_docker || die 2 "Could not start Docker. Start it manually and re-run."
  else
    if confirm "Docker not found. Install it now?"; then
      install_docker || die 2 "Docker install failed. Install it manually and re-run."
      docker_running || start_docker ||
        die 2 "Docker installed but not reachable. You may need to re-login for the
  docker group to take effect, then re-run ./bootstrap.sh."
    else
      die 2 "Docker is required. Install it (https://get.docker.com) and re-run."
    fi
  fi
fi

# --- 4. Hand off to the orchestrator ----------------------------------------
# The onecli CLI and other tools install into ~/.local/bin.
export PATH="$HOME/.local/bin:$PATH"

say ""
exec npx tsx setup/index.ts --step bootstrap -- "$@"
