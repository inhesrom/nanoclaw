#!/bin/sh
# install.sh — Automated installer for the EvenHub (Even G2) voice stack.
#
# Automates docs/evenhub-tailscale-deployment.md (and the optional LAN
# diagnostics from docs/evenhub-lan-deployment.md): snapshots, Moonshine STT,
# rendered config/firewall, systemd units + drop-ins, Tailscale Serve, and the
# private client package. Manual gates that genuinely need a human (Tailscale
# login, admin-console HTTPS enable, phone sideload, physical G2 smoke) pause
# with clear instructions.
#
# arm64 Linux only (the STT wheel lock and whisper assets are aarch64-pinned).
# Run as root:  sudo deploy/evenhub/install.sh [flags]
#
# Flags:
#   --origin <https://host.tailnet.ts.net>  Skip origin derivation/prompt
#   --lan-interface <iface>  --lan-subnet <cidr>  --lan-address <ip>
#   --no-lan               Skip the LAN/Caddy diagnostic module
#   --stt-profile <path>   Install a benchmarked profile instead of the candidate
#   --skip-client-build    Skip the evenhub/ npm build + .ehpk pack
#   --yes                  Non-interactive: fail at any unmet manual gate
#   --disable              Rollback fast-path: disable EvenHub and stop Serve
set -u

# --- Repo root (this script lives in deploy/evenhub/) ------------------------
REPO=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
DEPLOY="$REPO/deploy/evenhub"

# --- Flags ------------------------------------------------------------------
ORIGIN=""
LAN_IFACE=""
LAN_SUBNET=""
LAN_ADDR=""
LAN_ENABLED=true
STT_PROFILE=""
SKIP_CLIENT=false
ASSUME_YES=false
DO_DISABLE=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --origin) ORIGIN="${2:?}"; shift 2 ;;
    --lan-interface) LAN_IFACE="${2:?}"; shift 2 ;;
    --lan-subnet) LAN_SUBNET="${2:?}"; shift 2 ;;
    --lan-address) LAN_ADDR="${2:?}"; shift 2 ;;
    --no-lan) LAN_ENABLED=false; shift ;;
    --stt-profile) STT_PROFILE="${2:?}"; shift 2 ;;
    --skip-client-build) SKIP_CLIENT=true; shift ;;
    --yes) ASSUME_YES=true; shift ;;
    --disable) DO_DISABLE=true; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "✗ $1" >&2; exit "${2:-1}"; }
step() { echo ""; echo "== $1"; }

# --- Root + owner -----------------------------------------------------------
[ "$(id -u)" -eq 0 ] || die "run as root (sudo deploy/evenhub/install.sh)" 2
OWNER="${SUDO_USER:-}"
[ -n "$OWNER" ] && [ "$OWNER" != "root" ] ||
  die "SUDO_USER must be your normal user — run via 'sudo', not a root shell." 2
OWNER_HOME=$(getent passwd "$OWNER" | cut -d: -f6)

# --- Rollback fast-path -----------------------------------------------------
if [ "$DO_DISABLE" = "true" ]; then
  step "Disabling EvenHub"
  if [ -f /etc/nanoclaw/evenhub.env ]; then
    sed -i 's/^EVENHUB_ENABLED=.*/EVENHUB_ENABLED=false/' /etc/nanoclaw/evenhub.env
    echo "Set EVENHUB_ENABLED=false in /etc/nanoclaw/evenhub.env"
  fi
  systemctl stop nanoclaw-tailscale-serve.service 2>/dev/null || true
  systemctl restart nanoclaw.service 2>/dev/null || true
  echo "EvenHub disabled. Moonshine/firewall left running; snapshots preserved."
  echo "Full rollback stays manual — see the Rollback section of the deployment doc."
  exit 0
fi

# ===========================================================================
# Phase 0 — Preflight
# ===========================================================================
step "Phase 0: preflight"

[ "$(uname -s)" = "Linux" ] ||
  die "EvenHub deployment supports arm64 Linux only (this is $(uname -s))." 4
[ "$(uname -m)" = "aarch64" ] ||
  die "EvenHub requires aarch64 — the STT wheel lock and whisper assets are
  arm64-pinned. Porting needs new lock files + physical benchmark evidence." 4
command -v systemctl >/dev/null 2>&1 || die "systemd (systemctl) is required." 4
[ -f "$REPO/dist/index.js" ] ||
  die "$REPO/dist/index.js not found — build the core first (npm run build)." 2
command -v python3.13 >/dev/null 2>&1 ||
  die "python3.13 is required for the Moonshine STT venv." 2
command -v nft >/dev/null 2>&1 || die "nftables (nft) is required." 2
command -v tailscale >/dev/null 2>&1 || die "tailscale is required." 2
systemctl is-active --quiet tailscaled 2>/dev/null ||
  die "tailscaled is not active. Install/start Tailscale and 'tailscale up' first." 2

# Defensive: the owner's private files must stay gitignored.
git -C "$REPO" check-ignore -q evenhub/.env.private ||
  die "evenhub/.env.private is not gitignored — refusing to create secrets." 1
git -C "$REPO" check-ignore -q evenhub/placeholder.ehpk ||
  die "*.ehpk is not gitignored — refusing to build a client package." 1

if [ "$LAN_ENABLED" = "true" ]; then
  for bin in caddy avahi-daemon; do
    if ! command -v "$bin" >/dev/null 2>&1 &&
      [ ! -x "/usr/sbin/$bin" ] && ! systemctl list-unit-files "$bin.service" >/dev/null 2>&1; then
      if command -v apt-get >/dev/null 2>&1; then
        echo "LAN module needs $bin."
        if [ "$ASSUME_YES" = "true" ]; then
          apt-get install -y caddy avahi-daemon nftables || die "apt install failed" 2
        else
          printf 'Install caddy + avahi-daemon via apt now? [Y/n] '
          read -r r
          case "$r" in [nN]*) die "LAN module needs $bin — install it or pass --no-lan." 2 ;; esac
          apt-get install -y caddy avahi-daemon nftables || die "apt install failed" 2
        fi
      else
        die "LAN module needs $bin (no apt-get to auto-install). Install it or pass --no-lan." 2
      fi
    fi
  done
fi

# Legacy Whisper conflicts with Moonshine on port 8178.
if systemctl is-active --quiet nanoclaw-whisper.service 2>/dev/null; then
  echo "Legacy nanoclaw-whisper.service is active and conflicts with Moonshine (port 8178)."
  if [ "$ASSUME_YES" = "true" ]; then
    systemctl disable --now nanoclaw-whisper.service || true
  else
    printf 'Stop and disable nanoclaw-whisper.service? [Y/n] '
    read -r r
    case "$r" in [nN]*) die "Stop nanoclaw-whisper.service first (port 8178 conflict)." 2 ;; esac
    systemctl disable --now nanoclaw-whisper.service || true
  fi
fi

# --- Unit seam: EvenHub's drop-in needs a SYSTEM nanoclaw.service -----------
# nanoclaw.service.d/evenhub.conf uses Requires=nanoclaw-moonshine.service +
# EnvironmentFile, which only attach to a system unit. bootstrap installs a
# --user unit for non-root, so migrate to a system unit if needed.
NODE_BIN=$(command -v node || echo /usr/bin/node)
if [ ! -f /etc/systemd/system/nanoclaw.service ]; then
  echo "No system nanoclaw.service found — migrating from the user unit."
  cat >/etc/systemd/system/nanoclaw.service <<EOF
[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
User=$OWNER
Group=$OWNER
ExecStart=$NODE_BIN $REPO/dist/index.js
WorkingDirectory=$REPO
Restart=always
RestartSec=5
KillMode=process
UMask=0077
Environment=HOME=$OWNER_HOME
Environment=PATH=/usr/local/bin:/usr/bin:/bin:$OWNER_HOME/.local/bin
StandardOutput=append:$REPO/logs/nanoclaw.log
StandardError=append:$REPO/logs/nanoclaw.error.log

[Install]
WantedBy=multi-user.target
EOF
  # Tear down the user unit so the two never run concurrently.
  OWNER_UID=$(id -u "$OWNER")
  runuser -u "$OWNER" -- env "XDG_RUNTIME_DIR=/run/user/$OWNER_UID" \
    systemctl --user disable --now nanoclaw.service 2>/dev/null || true
  loginctl enable-linger "$OWNER" 2>/dev/null || true
  systemctl daemon-reload
  systemctl enable nanoclaw.service 2>/dev/null || true
  echo "Installed system nanoclaw.service (User=$OWNER)."
fi

# ===========================================================================
# Phase 1 — Snapshot
# ===========================================================================
step "Phase 1: snapshot"
TS=$(date -u +%Y%m%dT%H%M%SZ)
RUN_DIR="/var/lib/nanoclaw/private-evidence/pre-evenhub-install-$TS"
install -d -m 0700 "$(dirname "$RUN_DIR")"
install -d -m 0700 "$RUN_DIR" "$RUN_DIR/replaced"
LOG="$RUN_DIR/install.log"
touch "$LOG" && chmod 0600 "$LOG"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a "$LOG"; }
log "Installer run dir: $RUN_DIR"
"$DEPLOY/snapshot-before-tailscale.sh" "$RUN_DIR/tailscale" 2>>"$LOG" || log "tailscale snapshot: non-fatal error"
"$DEPLOY/snapshot-before-moonshine.sh" "$RUN_DIR/moonshine" 2>>"$LOG" || log "moonshine snapshot: non-fatal error"
log "Snapshots written."

# ===========================================================================
# Phase 2 — Tailscale identity + origin (manual gates)
# ===========================================================================
step "Phase 2: Tailscale identity"

# Re-check loop for a manual condition; honors --yes (fail instead of pause).
gate() { # description ; then caller re-tests
  if [ "$ASSUME_YES" = "true" ]; then die "unmet gate (--yes): $1" 3; fi
  printf '%s\n[Enter] to re-check, [q] to abort: ' "$1"
  read -r r
  case "$r" in [qQ]*) die "aborted at gate: $1" 3 ;; esac
}

while ! tailscale status --json 2>/dev/null | grep -q '"BackendState": *"Running"'; do
  gate "Tailscale is not logged in / running. Run 'sudo tailscale up' in another terminal."
done

# Hostname (consented rename).
SELF_DNS=$(tailscale status --json 2>/dev/null | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(((j.Self&&j.Self.DNSName)||"").replace(/\.$/,""))}catch{}})' 2>/dev/null)
log "Tailscale self DNS: ${SELF_DNS:-<unknown>}"
case "$SELF_DNS" in
  nanoclaw.*) : ;;
  *)
    if [ "$ASSUME_YES" != "true" ]; then
      printf "Rename this node to 'nanoclaw' via tailscale? (current: %s) [y/N] " "${SELF_DNS:-?}"
      read -r r
      case "$r" in
        [yY]*)
          tailscale set --hostname=nanoclaw || true
          sleep 2
          SELF_DNS=$(tailscale status --json 2>/dev/null | node -e \
            'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(((j.Self&&j.Self.DNSName)||"").replace(/\.$/,""))}catch{}})' 2>/dev/null)
          ;;
      esac
    fi
    ;;
esac

# HTTPS certificates enabled?
while ! tailscale status --json 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.exit((j.CertDomains&&j.CertDomains.length)?0:1)}catch{process.exit(1)}})'; do
  gate "HTTPS certificates are not enabled. In the Tailscale admin DNS page, enable
  HTTPS certificates and accept the public Certificate-Transparency disclosure
  (do this AFTER the rename)."
done

# Funnel must not be public.
if tailscale funnel status 2>/dev/null | grep -qi "available on the internet"; then
  die "Tailscale Funnel exposes a public listener. EvenHub must be tailnet-only —
  turn Funnel off before continuing." 1
fi

# Derive + confirm origin.
[ -n "$ORIGIN" ] || ORIGIN="https://${SELF_DNS}"
if [ "$ASSUME_YES" != "true" ]; then
  printf "Use origin '%s'? [Y/n or paste another] " "$ORIGIN"
  read -r r
  case "$r" in
    "" | [yY]*) : ;;
    https://*) ORIGIN="$r" ;;
    [nN]*) die "Re-run with --origin <https://host.tailnet.ts.net>." 3 ;;
    *) ORIGIN="$r" ;;
  esac
fi
# Validate the same shape validateEvenHubRuntimeConfig enforces:
# https, no port, no path, hostname ends .ts.net, >=4 labels.
echo "$ORIGIN" | grep -Eq '^https://[A-Za-z0-9-]+\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.ts\.net$' ||
  die "Origin '$ORIGIN' is not a canonical HTTPS ts.net origin (https://device.tailnet.ts.net)." 1
log "EvenHub origin: $ORIGIN"

# ===========================================================================
# Phase 3 — Moonshine STT
# ===========================================================================
step "Phase 3: Moonshine STT"
RUNTIME_DIR=/opt/nanoclaw/moonshine-0.0.69
MODEL_DIR=/var/lib/nanoclaw/stt/moonshine-streaming-small-en
SELECTED_PROFILE=/etc/nanoclaw/stt-selected-profile.json
install -d -o root -g root -m 0755 /etc/nanoclaw
if [ -d "$RUNTIME_DIR" ] && [ -f /opt/nanoclaw/moonshine-server/moonshine_server.py ] && [ -d "$MODEL_DIR" ]; then
  log "Moonshine already installed — skipping."
else
  log "Installing Moonshine candidate (venv + model download; slow)..."
  "$DEPLOY/moonshine/install-candidate.sh" 2>&1 | tee -a "$LOG" ||
    die "Moonshine candidate install failed — see $LOG" 1
fi

# Stage the selected profile the moonshine unit reads.
if [ -n "$STT_PROFILE" ]; then
  [ -f "$STT_PROFILE" ] || die "--stt-profile '$STT_PROFILE' not found" 2
  install -o root -g nanoclaw-stt -m 0640 "$STT_PROFILE" "$SELECTED_PROFILE"
  log "Installed benchmarked STT profile from $STT_PROFILE"
elif [ ! -f "$SELECTED_PROFILE" ]; then
  if [ -f /var/lib/nanoclaw/stt/candidate-profile.json ]; then
    install -o root -g nanoclaw-stt -m 0640 \
      /var/lib/nanoclaw/stt/candidate-profile.json "$SELECTED_PROFILE"
    log "!!! PROVISIONAL: staged the CANDIDATE STT profile. Run the physical"
    log "!!! benchmark + select-profile.mjs before treating this as production"
    log "!!! (see docs/evenhub-lan-deployment.md)."
  else
    die "No selected or candidate STT profile found; cannot configure Moonshine." 1
  fi
else
  log "Existing selected STT profile kept: $SELECTED_PROFILE"
fi

# ===========================================================================
# Phase 4 — Render + install config files (idempotent)
# ===========================================================================
step "Phase 4: config files"

# render_install <tmpfile> <dest> <owner> <group> <mode>
render_install() {
  _tmp=$1; _dest=$2; _own=$3; _grp=$4; _mode=$5
  if [ -f "$_dest" ] && cmp -s "$_tmp" "$_dest"; then
    log "unchanged: $_dest"
  else
    [ -f "$_dest" ] && cp -a "$_dest" "$RUN_DIR/replaced/$(basename "$_dest")"
    install -o "$_own" -g "$_grp" -m "$_mode" "$_tmp" "$_dest"
    log "installed: $_dest"
  fi
  rm -f "$_tmp"
}

# evenhub.env (origin substituted)
tmp=$(mktemp)
sed "s#REPLACE_WITH_TAILSCALE_HTTPS_ORIGIN#${ORIGIN}#" \
  "$DEPLOY/config/evenhub.env.template" >"$tmp"
render_install "$tmp" /etc/nanoclaw/evenhub.env root root 0600

# nftables (detect LAN interface/subnet unless provided)
if [ -z "$LAN_IFACE" ]; then
  LAN_IFACE=$(ip route show default 2>/dev/null | awk '{for(i=1;i<NF;i++)if($i=="dev")print $(i+1);exit}')
fi
if [ -z "$LAN_SUBNET" ] && [ -n "$LAN_IFACE" ]; then
  LAN_SUBNET=$(ip -o -4 addr show dev "$LAN_IFACE" 2>/dev/null | awk '{print $4;exit}' |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const[ip,b]=s.trim().split("/");if(!ip){process.exit(0)}const o=ip.split(".").map(Number);const bits=+b;const mask=[0,0,0,0].map((_,i)=>{const n=Math.min(Math.max(bits-i*8,0),8);return 256-Math.pow(2,8-n)});const net=o.map((x,i)=>x&mask[i]);process.stdout.write(net.join(".")+"/"+bits)})' 2>/dev/null)
fi
[ -n "$LAN_IFACE" ] || die "Could not detect LAN interface; pass --lan-interface." 2
[ -n "$LAN_SUBNET" ] || die "Could not detect LAN subnet; pass --lan-subnet." 2
if [ "$ASSUME_YES" != "true" ]; then
  printf "LAN interface '%s' subnet '%s' — correct? [Y/n] " "$LAN_IFACE" "$LAN_SUBNET"
  read -r r
  case "$r" in [nN]*) die "Pass --lan-interface / --lan-subnet explicitly." 3 ;; esac
fi
install -d -o root -g root -m 0755 /etc/nftables.d
tmp=$(mktemp)
sed -e "s#REPLACE_LAN_INTERFACE#${LAN_IFACE}#" \
  -e "s#192\\.0\\.2\\.0/24#${LAN_SUBNET}#" \
  "$DEPLOY/firewall/nanoclaw-evenhub.nft.template" >"$tmp"
render_install "$tmp" /etc/nftables.d/nanoclaw-evenhub.nft root root 0644

# LAN module: caddy env, Caddyfile, avahi
if [ "$LAN_ENABLED" = "true" ]; then
  if [ -z "$LAN_ADDR" ]; then
    LAN_ADDR=$(ip -o -4 addr show dev "$LAN_IFACE" 2>/dev/null | awk '{print $4;exit}' | cut -d/ -f1)
  fi
  [ -n "$LAN_ADDR" ] || die "Could not detect LAN address; pass --lan-address or --no-lan." 2
  tmp=$(mktemp)
  sed "s#192\\.0\\.2\\.10#${LAN_ADDR}#" \
    "$DEPLOY/config/evenhub-caddy.env.template" >"$tmp"
  render_install "$tmp" /etc/nanoclaw/evenhub-caddy.env root root 0644
  install -d -o root -g root -m 0755 /etc/caddy
  tmp=$(mktemp); cp "$DEPLOY/Caddyfile" "$tmp"
  render_install "$tmp" /etc/caddy/Caddyfile root root 0644
  install -d -o root -g root -m 0755 /etc/avahi/services
  tmp=$(mktemp); cp "$DEPLOY/avahi/nanoclaw.service" "$tmp"
  render_install "$tmp" /etc/avahi/services/nanoclaw.service root root 0644
fi

# ===========================================================================
# Phase 5 — systemd units + drop-ins
# ===========================================================================
step "Phase 5: systemd units"
for unit in nanoclaw-evenhub-firewall.service nanoclaw-moonshine.service \
  nanoclaw-tailscale-serve.service; do
  tmp=$(mktemp); cp "$DEPLOY/systemd/$unit" "$tmp"
  render_install "$tmp" "/etc/systemd/system/$unit" root root 0644
done
install -d -o root -g root -m 0755 /etc/systemd/system/nanoclaw.service.d
tmp=$(mktemp); cp "$DEPLOY/systemd/nanoclaw.service.d/evenhub.conf" "$tmp"
render_install "$tmp" /etc/systemd/system/nanoclaw.service.d/evenhub.conf root root 0644
if [ "$LAN_ENABLED" = "true" ]; then
  install -d -o root -g root -m 0755 /etc/systemd/system/caddy.service.d
  tmp=$(mktemp); cp "$DEPLOY/systemd/caddy.service.d/evenhub.conf" "$tmp"
  render_install "$tmp" /etc/systemd/system/caddy.service.d/evenhub.conf root root 0644
fi

# ===========================================================================
# Phase 6 — Validate before activating
# ===========================================================================
step "Phase 6: validate"
nft -c -f /etc/nftables.d/nanoclaw-evenhub.nft || die "nftables ruleset failed validation" 1
if [ "$LAN_ENABLED" = "true" ] && command -v caddy >/dev/null 2>&1; then
  caddy validate --config /etc/caddy/Caddyfile 2>>"$LOG" || die "Caddyfile failed validation" 1
fi
systemd-analyze verify \
  /etc/systemd/system/nanoclaw-evenhub-firewall.service \
  /etc/systemd/system/nanoclaw-moonshine.service \
  /etc/systemd/system/nanoclaw-tailscale-serve.service 2>>"$LOG" ||
  log "systemd-analyze verify reported warnings (see $LOG)"
tailscale funnel status 2>/dev/null | grep -qi "available on the internet" &&
  die "Funnel became public during install — aborting before activation." 1
systemctl daemon-reload
log "Validation passed."

# ===========================================================================
# Phase 7 — Enable/start in dependency order
# ===========================================================================
step "Phase 7: activate"
activate() { # unit  action(enable|restart)
  if [ "$2" = "restart" ]; then systemctl restart "$1"; else systemctl enable --now "$1"; fi
  for _ in 1 2 3 4 5; do
    systemctl is-active --quiet "$1" && { log "active: $1"; return 0; }
    sleep 1
  done
  echo "  journalctl -u $1 -n 50   (snapshot: $RUN_DIR)" >&2
  die "$1 did not become active" 1
}
activate nanoclaw-evenhub-firewall.service enable
[ "$LAN_ENABLED" = "true" ] && activate avahi-daemon.service enable
activate nanoclaw-moonshine.service enable
[ "$LAN_ENABLED" = "true" ] && systemctl restart caddy.service && log "restarted caddy"
activate nanoclaw.service restart
activate nanoclaw-tailscale-serve.service enable

# ===========================================================================
# Phase 8 — Private client build + .ehpk
# ===========================================================================
if [ "$SKIP_CLIENT" = "true" ]; then
  step "Phase 8: client build (skipped)"
else
  step "Phase 8: private client build"
  if [ ! -f "$REPO/evenhub/.env.private" ]; then
    runuser -u "$OWNER" -- sh -c "cp '$REPO/evenhub/.env.private.example' '$REPO/evenhub/.env.private' && chmod 0600 '$REPO/evenhub/.env.private'"
    runuser -u "$OWNER" -- sed -i "s#^EVENHUB_ORIGIN=.*#EVENHUB_ORIGIN=${ORIGIN}#" "$REPO/evenhub/.env.private"
    log "Created evenhub/.env.private (0600) with the deployment origin."
  else
    log "evenhub/.env.private exists — leaving it untouched."
  fi
  log "Building client as $OWNER (npm ci/test/pack)..."
  if runuser -u "$OWNER" -- sh -c "cd '$REPO/evenhub' && npm ci && npm test && npm run pack:verify && npm run pack:private" 2>&1 | tee -a "$LOG"; then
    EHPK=$(ls -1t "$REPO"/evenhub/nanoclaw-evenhub-*.ehpk 2>/dev/null | head -n1)
    if [ -n "$EHPK" ]; then
      log "Built client package: $EHPK"
      log "sha256: $(sha256sum "$EHPK" | awk '{print $1}')"
    fi
  else
    log "Client build failed — the backend is up; re-run pack in evenhub/ later."
  fi
fi

# ===========================================================================
# Phase 9 — Verify
# ===========================================================================
step "Phase 9: verify"
"$DEPLOY/verify.sh" --fqdn "$(echo "$ORIGIN" | sed 's#^https://##')" || log "verify.sh reported failures — review above."

# ===========================================================================
# Phase 10 — Manual epilogue
# ===========================================================================
step "Done — remaining manual steps"
cat <<EOF
1. Sideload the .ehpk on your companion phone (Tailscale connected).
EOF
if [ "$LAN_ENABLED" = "true" ]; then
  CA=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
  if [ -r "$CA" ]; then
    echo "2. (LAN diagnostics) Trust Caddy's local CA on your phone — verify out of band:"
    echo "   $CA"
    echo "   sha256: $(sha256sum "$CA" | awk '{print $1}')"
  fi
fi
cat <<EOF
3. Pair the device:  sudo -u $OWNER npm --prefix "$REPO" run evenhub:pair
4. Run the physical G2 smoke checklist in docs/evenhub-tailscale-deployment.md.

Rollback fast-path:  sudo $DEPLOY/install.sh --disable
Snapshot / evidence: $RUN_DIR
EOF
