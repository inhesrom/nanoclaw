# Obsidian Vault Integration

NanoClaw can read and edit your Obsidian vaults over WhatsApp. Vaults are mounted into the agent container so it can create, search, and modify notes directly. Obsidian Sync (via the `ob` headless CLI) keeps them in sync with your other devices.

## Prerequisites

- An [Obsidian Sync](https://obsidian.md/sync) subscription
- The `ob` headless CLI installed (`which ob` should return a path)
- NanoClaw running and connected to WhatsApp

---

## 1. Install the `ob` CLI

The `ob` binary is the headless Obsidian client. On Debian/Ubuntu/Raspberry Pi OS:

```bash
# Check if already installed
which ob

# If not, download from the Obsidian releases page:
# https://github.com/obsidianmd/obsidian-releases/releases
# Look for obsidian-headless-*-linux-arm64 (Raspberry Pi) or linux-x64
# Then move the binary to somewhere in your PATH:
sudo install -m 0755 ob /usr/local/bin/ob
```

---

## 2. Log in to your Obsidian account

```bash
ob login
# Enter your email, password, and MFA code when prompted
```

Verify login:

```bash
ob login
# Should show: Logged in as <your email>
```

---

## 3. Set up each vault

Vaults live at `~/clawdir/vaults/`. For each vault you want to sync:

```bash
# Create the local vault directory
mkdir -p ~/clawdir/vaults/MyVault

# List your remote vaults to find the name/ID
ob sync-list-remote

# Link the local directory to a remote vault
cd ~/clawdir/vaults/MyVault
ob sync-setup --vault "MyVault" --device-name "pi5-nanoclaw"
# You will be prompted for your end-to-end encryption password

# Do an initial sync to pull down all notes
ob sync
```

Repeat for each vault. The sync service will pick up any directory under `~/clawdir/vaults/` automatically.

---

## 4. Install the sync service

From the repo root, run:

```bash
./install_obsidiansync_service.sh
```

This installs a systemd timer that runs `ob sync` in every vault directory every 30 seconds. Verify it is running:

```bash
systemctl --user status obsidian-sync.timer
```

Watch live sync output (logs go to the system journal):

```bash
journalctl _SYSTEMD_USER_UNIT=obsidian-sync.service -f
```

---

## 5. Adding a new vault later

```bash
mkdir -p ~/clawdir/vaults/NewVault
cd ~/clawdir/vaults/NewVault
ob sync-setup --vault "NewVault" --device-name "pi5-nanoclaw"
ob sync
```

No service restart needed — the sync script discovers vaults dynamically.

---

## 6. Using it from WhatsApp

Once a vault is set up, just message Claw naturally. Examples:

> Add a note to my personal vault called "Book ideas" with the following content: ...

> Search my citra vault for notes about project X

> What's in my daily note for today?

> Edit the "Shopping list" note and add olive oil

The agent has the `/obsidian` skill loaded which gives it full knowledge of vault structure, frontmatter, daily notes, wikilinks, and search.

---

## Vault structure reference

```
~/clawdir/vaults/
├── citra/             ← vault root (name matches remote vault)
│   ├── .obsidian/     ← Obsidian config — do not edit manually
│   └── *.md           ← your notes
└── personal/
    ├── .obsidian/
    ├── Daily/         ← daily notes folder (if configured)
    └── *.md
```

Inside the agent container, vaults are at `/workspace/extra/vaults/`.

---

## Troubleshooting

**Sync not running:**
```bash
systemctl --user status obsidian-sync.timer
journalctl _SYSTEMD_USER_UNIT=obsidian-sync.service --no-pager | tail -20
```

**Re-authenticate:**
```bash
ob logout
ob login
```

**Check sync status for a vault:**
```bash
cd ~/clawdir/vaults/citra
ob sync-status
```

**Vault not being picked up by NanoClaw:**
Make sure the vault directory exists under `~/clawdir/vaults/` and that NanoClaw has been restarted at least once since the vault was added:
```bash
systemctl --user restart nanoclaw
```
