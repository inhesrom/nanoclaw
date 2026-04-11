#!/usr/bin/env bash
# Sync all Obsidian vaults in ~/clawdir/vaults/ using `ob sync`
set -euo pipefail

VAULTS_DIR="$HOME/clawdir/vaults"

for vault in "$VAULTS_DIR"/*/; do
  [ -d "$vault" ] || continue
  cd "$vault"
  ob sync 2>&1 || true
done
