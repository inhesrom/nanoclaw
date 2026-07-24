# One-command install (`./bootstrap.sh`)

`bootstrap.sh` takes a clean clone of your fork to a running NanoClaw service in
one command. It's the deterministic alternative to driving `/setup` through
Claude Code — same underlying steps, no chat loop. `/setup` remains the
AI-guided path (and `/debug` the repair path); use whichever you prefer.

```bash
./bootstrap.sh            # interactive
npm run bootstrap         # equivalent
```

## What it does

`bootstrap.sh` handles the pre-toolchain phase in bash (things that must work
before any TypeScript can run), then hands off to a TypeScript orchestrator
(`setup/index.ts --step bootstrap`) that chains the existing setup steps:

1. **Git remotes** — adds an `upstream` remote if missing; warns (never blocks)
   if `origin` still points at the canonical repo.
2. **Dependencies** — runs `bash setup.sh` (`npm ci` + native-module check)
   unless a working install is already present. The "is it working?" test opens
   an in-memory `better-sqlite3` database — the authoritative signal — so a
   working tree is never re-installed over.
3. **Docker** — verifies the daemon is up; offers to start or install it.
4. **Timezone**, **OneCLI** (credential gateway + Anthropic secret),
   **WhatsApp auth**, **container image build**, **group sync**, **main-channel
   registration**, **mount allowlist**, **service install/start**, **verify**.
5. **EvenHub** (optional) — runs `deploy/evenhub/install.sh` when requested.

Interactive gates run **before** the multi-minute image build, so you're not
called back to a stale (60-second) QR code after walking away.

## The three pause points

Everything else is automatic. These need a human:

| Gate | Why | Headless alternative |
| ---- | --- | -------------------- |
| **Docker install** | needs `sudo` | pre-install Docker |
| **Anthropic secret** | pasted into the OneCLI vault | `NANOCLAW_ANTHROPIC_SECRET` env var |
| **WhatsApp QR / pairing** | scanned on your phone | none — inherently interactive |

## Idempotent re-runs

Re-running `./bootstrap.sh` is safe. Each step detects prior completion and
reports `skipped` — dependencies (working `better-sqlite3`), OneCLI (secret
present), WhatsApp (`store/auth/creds.json`), container image (`docker image
inspect`), registration (an `is_main` group in the DB), mount allowlist (file
exists). If a run fails partway, fix the issue and re-run — it resumes where it
stopped.

## Flags

```
--non-interactive     Never prompt; exit 5 at any unmet gate
--runtime docker      Container runtime (only docker is supported here;
                      use /setup + /convert-to-apple-container for Apple Container)
--tz <IANA>           Timezone (else autodetected)
--onecli-url <url>    OneCLI gateway URL (else .env, else the Docker-bridge default)
--phone <number>      WhatsApp pairing-code mode (E.164, no +) instead of QR
--assistant-name <n>  Assistant name (else .env ASSISTANT_NAME)
--main-jid <jid>      Override the derived main-channel JID
--skip-register       Skip main-channel registration
--skip-service        Skip service install/start
--rebuild             Rebuild the agent image even if it exists
--with-evenhub        Install the EvenHub voice stack after verify
```

Environment: `NANOCLAW_ANTHROPIC_SECRET` provisions the OneCLI secret without a
prompt.

Exit codes: `0` success · `1` step failure · `2` missing prerequisite ·
`5` a gate was unmet under `--non-interactive`.

## Headless provisioning

```bash
NANOCLAW_ANTHROPIC_SECRET="$SECRET" ./bootstrap.sh \
  --non-interactive --tz America/Denver --skip-register
```

WhatsApp authentication can't be scripted (the QR is scanned on a phone). For a
fully headless box, either register a non-WhatsApp channel or copy an
already-authenticated `store/auth/` directory onto the machine first, then run
with `--non-interactive`.

## Hardened-npm environments

`bootstrap.sh` uses `npm ci`, which installs strictly from the lockfile. If your
machine restricts git-protocol installs or install scripts (a hardened npm
policy), a fresh `npm ci` will fail on git dependencies (e.g. `libsignal`) or
skip native builds (e.g. `better-sqlite3`). Install dependencies with your
vetted process **first** — bootstrap detects the working install and skips
`npm ci` entirely (it never reinstalls over a functioning `node_modules`).

## EvenHub

`--with-evenhub` (or answering yes at the prompt) runs
`sudo deploy/evenhub/install.sh` after verification. That installer is arm64
Linux only and has its own gates (Tailscale login, admin-console HTTPS,
phone sideload) — see
[docs/evenhub-tailscale-deployment.md](evenhub-tailscale-deployment.md).
