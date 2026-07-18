#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: snapshot-before-tailscale /absolute/owner-only/output-directory" >&2
  exit 1
fi
snapshot_dir=$1
case "$snapshot_dir" in
  /*) ;;
  *) echo "snapshot path must be absolute" >&2; exit 1 ;;
esac
if [ -e "$snapshot_dir" ]; then
  echo "snapshot destination already exists" >&2
  exit 1
fi

umask 077
install -d -m 0700 "$snapshot_dir"

tailscale version >"$snapshot_dir/tailscale-version.txt" 2>&1 || true
tailscale status --json >"$snapshot_dir/tailscale-status.json" 2>&1 || true
tailscale serve status --json >"$snapshot_dir/tailscale-serve.json" 2>&1 || true
tailscale funnel status --json >"$snapshot_dir/tailscale-funnel.json" 2>&1 || true
hostnamectl >"$snapshot_dir/hostname.txt" 2>&1 || true
ip -brief address >"$snapshot_dir/addresses.txt" 2>&1 || true
ss -lntup >"$snapshot_dir/listeners.txt" 2>&1 || true
nft list ruleset >"$snapshot_dir/nftables.txt" 2>&1 || true
systemctl cat tailscaled.service nanoclaw.service nanoclaw-moonshine.service \
  nanoclaw-evenhub-firewall.service caddy.service \
  >"$snapshot_dir/systemd-units.txt" 2>&1 || true
systemctl is-active tailscaled.service nanoclaw.service \
  nanoclaw-moonshine.service nanoclaw-evenhub-firewall.service caddy.service \
  >"$snapshot_dir/systemd-active.txt" 2>&1 || true
cp -a /etc/hostname "$snapshot_dir/" 2>/dev/null || true
cp -a /etc/nanoclaw/evenhub.env "$snapshot_dir/" 2>/dev/null || true
cp -a /etc/caddy/Caddyfile "$snapshot_dir/" 2>/dev/null || true
cp -a /etc/nftables.d/nanoclaw-evenhub.nft "$snapshot_dir/" 2>/dev/null || true

find "$snapshot_dir" -maxdepth 1 -type f ! -name SNAPSHOT.sha256 \
  -exec sha256sum {} + | sort >"$snapshot_dir/SNAPSHOT.sha256"
chmod 0600 "$snapshot_dir"/*
