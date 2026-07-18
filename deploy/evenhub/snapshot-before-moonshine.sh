#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: snapshot-before-moonshine /absolute/owner-only/output-directory" >&2
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
install -d -m 0700 "$snapshot_dir"

systemctl cat nanoclaw-whisper.service >"$snapshot_dir/nanoclaw-whisper.service.txt" 2>&1 || true
systemctl cat nanoclaw.service >"$snapshot_dir/nanoclaw.service.txt" 2>&1 || true
systemctl cat caddy.service >"$snapshot_dir/caddy.service.txt" 2>&1 || true
systemctl show nanoclaw-whisper.service nanoclaw.service caddy.service \
  >"$snapshot_dir/systemd-show.txt" 2>&1 || true
ss -lntup >"$snapshot_dir/listeners.txt" 2>&1 || true
nft list ruleset >"$snapshot_dir/nftables.txt" 2>&1 || true
find /opt/nanoclaw/whisper-v1.9.1 /var/lib/nanoclaw/whisper \
  -type f -exec sha256sum {} + >"$snapshot_dir/whisper-files.sha256" 2>&1 || true
cp -a /etc/nanoclaw/evenhub.env "$snapshot_dir/" 2>/dev/null || true
cp -a /etc/caddy/Caddyfile "$snapshot_dir/" 2>/dev/null || true
chmod -R go-rwx "$snapshot_dir"
sha256sum "$snapshot_dir"/* >"$snapshot_dir/SNAPSHOT.sha256"
chmod 0600 "$snapshot_dir"/*
