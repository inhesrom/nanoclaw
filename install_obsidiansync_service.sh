#!/usr/bin/env bash
# Install the Obsidian vault sync systemd service and timer.
# Copies units into ~/.config/systemd/user/ and enables the timer.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMD_USER_DIR="$HOME/.config/systemd/user"
SYNC_SCRIPT="$HOME/clawdir/sync-vaults.sh"
VAULTS_DIR="$HOME/clawdir/vaults"

echo "Installing Obsidian Sync service..."

# Ensure required directories exist
mkdir -p "$SYSTEMD_USER_DIR"
mkdir -p "$VAULTS_DIR"

# Copy sync script into place
install -m 0755 "$SCRIPT_DIR/clawdir/sync-vaults.sh" "$SYNC_SCRIPT"

# Write service unit
cat > "$SYSTEMD_USER_DIR/obsidian-sync.service" << 'EOF'
[Unit]
Description=Obsidian vault sync (ob sync)
After=network.target

[Service]
Type=oneshot
ExecStart=%h/clawdir/sync-vaults.sh
StandardOutput=journal
StandardError=journal
EOF

# Write timer unit
cat > "$SYSTEMD_USER_DIR/obsidian-sync.timer" << 'EOF'
[Unit]
Description=Run Obsidian vault sync every 30 seconds
Requires=obsidian-sync.service

[Timer]
OnBootSec=10s
OnUnitActiveSec=30s
AccuracySec=1s

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now obsidian-sync.timer

echo "Done. Timer status:"
systemctl --user status obsidian-sync.timer --no-pager
