#!/usr/bin/env bash
# Probe Google OAuth apps through the local OneCLI gateway.
#
# Host usage (via local OneCLI plane):
#   ONECLI_API_HOST=http://172.17.0.1:10254 onecli run -- \
#     bash /home/ian/repo/nanoclaw/scripts/check-google-auth.sh --host
#
# Container / scheduled-task usage (proxy already in env):
#   bash scripts/check-google-auth.sh --json
#
# Exit codes: 0 = all ok, 1 = one or more 401/auth failures, 2 = probe error

set -euo pipefail

MODE="${1:---human}"
# Allow --json / --host / --human
case "$MODE" in
  --json|--host|--human) ;;
  *) MODE="--human" ;;
esac

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

# Calendar is the canary (same Google BYOC refresh token family as Gmail/Docs/Drive).
RESULTS=()
RESULTS+=("$(probe calendar "https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1")")
RESULTS+=("$(probe gmail "https://gmail.googleapis.com/gmail/v1/users/me/profile")")
RESULTS+=("$(probe drive "https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)")")
# Control: GitHub should stay healthy when only Google tokens die.
RESULTS+=("$(probe github "https://api.github.com/user")")

failed=()
ok=()
for row in "${RESULTS[@]}"; do
  name="${row%%$'\t'*}"
  rest="${row#*$'\t'}"
  code="${rest%%$'\t'*}"
  if [[ "$code" == "200" ]]; then
    ok+=("$name")
  else
    failed+=("$name:$code")
  fi
done

if [[ "$MODE" == "--json" ]]; then
  # Last line is JSON for NanoClaw scheduled-task script protocol.
  if [[ ${#failed[@]} -eq 0 ]]; then
    echo '{"wakeAgent":false,"data":{"ok":true,"services":["calendar","gmail","drive","github"]}}'
    exit 0
  fi
  # Build a compact JSON payload without requiring jq.
  fail_json=""
  for f in "${failed[@]}"; do
    svc="${f%%:*}"
    code="${f##*:}"
    [[ -n "$fail_json" ]] && fail_json+=","
    fail_json+="{\"service\":\"$svc\",\"httpStatus\":$code}"
  done
  echo "{\"wakeAgent\":true,\"data\":{\"ok\":false,\"failures\":[$fail_json],\"hint\":\"Reconnect Google apps in local OneCLI (SSH tunnel to :10254). See groups/whatsapp_main/google-calendar-onecli.md\"}}"
  exit 1
fi

echo "Google auth probe via OneCLI gateway"
echo "===================================="
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
echo "Recovery: SSH tunnel + reconnect in local OneCLI dashboard"
echo "  ssh -N -L 10254:172.17.0.1:10254 USER@SERVER"
echo "  open http://localhost:10254/connections/apps/google-calendar"
echo "  also reconnect gmail, google-docs, google-drive"
echo "  (If this dies every ~7 days: publish OAuth consent to Production in GCP project nanoclawproject-495505)"
exit 1
