#!/usr/bin/env bash
# Probe Google auth used by NanoClaw.
#
# Two families:
#   calendar / gmail / drive / github — OneCLI gateway (Bearer onecli-managed)
#   sheets-host — dedicated host refresh token (bypasses OneCLI; must not use the proxy)
#
# Host usage (via local OneCLI plane for the gateway family):
#   ONECLI_API_HOST=http://172.17.0.1:10254 onecli run -- \
#     bash /home/ian/repo/nanoclaw/scripts/check-google-auth.sh --host
#
# Container / scheduled-task usage (proxy already in env for OneCLI probes):
#   bash /workspace/project/scripts/check-google-auth.sh --json
#
# Exit codes (CLI modes only): 0 = all ok, 1 = one or more failures
# --json always exits 0 so NanoClaw task scripts can wake on wakeAgent=true
# (a non-zero exit is treated as a script error and does not wake the agent).

set -euo pipefail

MODE="${1:---human}"
# Allow --json / --host / --human
case "$MODE" in
  --json|--host|--human) ;;
  *) MODE="--human" ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

probe() {
  local name="$1" url="$2"
  local body code
  body="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '$body'" RETURN
  code="$(
    curl -sS -o "$body" -w "%{http_code}" --max-time 20 \
      -H "Authorization: Bearer onecli-managed" \
      "$url" 2>/dev/null || echo "000"
  )"
  local snippet
  snippet="$(head -c 240 "$body" | tr '\n' ' ' | tr '"' "'" || true)"
  printf '%s\t%s\t%s\n' "$name" "$code" "$snippet"
}

probe_sheets_host() {
  # Direct HTTPS — OneCLI's shared oauth2.googleapis.com handling is misattributed.
  env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy \
    -u ALL_PROXY -u all_proxy \
    node "$SCRIPT_DIR/probe-sheets-host.mjs"
}

# Calendar is the canary (same Google BYOC refresh token family as Gmail/Docs/Drive).
RESULTS=()
RESULTS+=("$(probe calendar "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1")")
RESULTS+=("$(probe gmail "https://gmail.googleapis.com/gmail/v1/users/me/profile")")
RESULTS+=("$(probe drive "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)")")
# Control: GitHub should stay healthy when only Google tokens die.
RESULTS+=("$(probe github "https://api.github.com/user")")
RESULTS+=("$(probe_sheets_host)")

failed=()
ok=()
sheets_failed=0
onecli_failed=0
for row in "${RESULTS[@]}"; do
  name="${row%%$'\t'*}"
  rest="${row#*$'\t'}"
  code="${rest%%$'\t'*}"
  if [[ "$code" == "200" ]]; then
    ok+=("$name")
  else
    failed+=("$name:$code")
    if [[ "$name" == "sheets-host" ]]; then
      sheets_failed=1
    elif [[ "$name" != "github" ]]; then
      onecli_failed=1
    fi
  fi
done

hint=""
if [[ "$sheets_failed" -eq 1 ]]; then
  hint+="Sheets uses the host token at ~/.config/nanoclaw-sheets (not OneCLI). Re-run: node scripts/sheets-oauth-setup.mjs (ssh -L 8766:localhost:8766 if remote). Publish OAuth consent to Production for GCP project nanoclawproject-495505 or the grant dies in ~7 days. See google-calendar-onecli.md Sheets section."
fi
if [[ "$onecli_failed" -eq 1 ]]; then
  [[ -n "$hint" ]] && hint+=" "
  hint+="Reconnect Calendar/Gmail/Docs/Drive in local OneCLI (SSH tunnel to :10254). See groups/whatsapp_main/google-calendar-onecli.md"
fi

# Always include a full service map so the host poller can detect transitions.
svc_json=""
fail_json=""
for row in "${RESULTS[@]}"; do
  name="${row%%$'\t'*}"
  rest="${row#*$'\t'}"
  code="${rest%%$'\t'*}"
  if [[ "$code" == "200" ]]; then
    ok_json="true"
  else
    ok_json="false"
    [[ -n "$fail_json" ]] && fail_json+=","
    fail_json+="{\"service\":\"$name\",\"httpStatus\":$code}"
  fi
  [[ -n "$svc_json" ]] && svc_json+=","
  svc_json+="\"$name\":{\"ok\":$ok_json,\"httpStatus\":$code}"
done

if [[ "$MODE" == "--json" ]]; then
  if [[ ${#failed[@]} -eq 0 ]]; then
    echo "{\"wakeAgent\":false,\"data\":{\"ok\":true,\"services\":{$svc_json}}}"
    exit 0
  fi
  hint_esc="${hint//\\/\\\\}"
  hint_esc="${hint_esc//\"/\\\"}"
  echo "{\"wakeAgent\":true,\"data\":{\"ok\":false,\"services\":{$svc_json},\"failures\":[$fail_json],\"hint\":\"$hint_esc\"}}"
  exit 0
fi

echo "Google auth probe"
echo "================="
for row in "${RESULTS[@]}"; do
  name="${row%%$'\t'*}"
  rest="${row#*$'\t'}"
  code="${rest%%$'\t'*}"
  snippet="${rest#*$'\t'}"
  if [[ "$code" == "200" ]]; then
    echo "  OK  $name (HTTP $code)"
  else
    echo "  FAIL $name (HTTP $code) ${snippet:0:120}"
  fi
done

if [[ ${#failed[@]} -eq 0 ]]; then
  echo "All probes healthy."
  exit 0
fi

echo
echo "Failures: ${failed[*]}"
if [[ "$sheets_failed" -eq 1 ]]; then
  echo "Sheets recovery (host token, not OneCLI):"
  echo "  node scripts/sheets-oauth-setup.mjs"
  echo "  remote: ssh -N -L 8766:localhost:8766 USER@SERVER"
  echo "  Publish OAuth consent to Production in GCP project nanoclawproject-495505"
fi
if [[ "$onecli_failed" -eq 1 ]]; then
  echo "OneCLI recovery:"
  echo "  ssh -N -L 10254:172.17.0.1:10254 USER@SERVER"
  echo "  open http://localhost:10254/connections/apps/google-calendar"
  echo "  also reconnect gmail, google-docs, google-drive"
  echo "  (If this dies every ~7 days: publish OAuth consent to Production in GCP project nanoclawproject-495505)"
fi
exit 1
