#!/bin/sh
# verify.sh — End-to-end health check for the EvenHub voice stack.
#
# Runs standalone or as the last phase of install.sh. Checks service liveness,
# the STT and app loopback endpoints, the Tailscale HTTPS origin (including the
# protocol-version handshake), the optional LAN/Caddy diagnostic path, and the
# network boundary (listeners, nftables, tailscale serve/funnel scope).
#
# Prints a PASS/WARN/FAIL table and exits non-zero if any hard check fails.
# Boundary checks (ss -p, nft) need root; run with sudo for a complete report.
#
# Usage: sudo deploy/evenhub/verify.sh [--fqdn <host.tailnet.ts.net>]
set -u

FQDN="${EVENHUB_FQDN:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --fqdn)
      FQDN="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

ENV_FILE=/etc/nanoclaw/evenhub.env
APP_PORT=18791
STT_PORT=8178
ORIGIN=""
if [ -r "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  APP_PORT=$(sed -n 's/^EVENHUB_PORT=//p' "$ENV_FILE" | tr -d '\r' | head -n1)
  ORIGIN=$(sed -n 's/^EVENHUB_PUBLIC_ORIGIN=//p' "$ENV_FILE" | tr -d '\r' | head -n1)
  [ -n "$APP_PORT" ] || APP_PORT=18791
fi

# Derive the tailnet FQDN when not supplied.
if [ -z "$FQDN" ] && [ -n "$ORIGIN" ]; then
  FQDN=$(printf '%s' "$ORIGIN" | sed -e 's#^https\?://##' -e 's#/.*$##')
fi
if [ -z "$FQDN" ] && command -v tailscale >/dev/null 2>&1 &&
  command -v node >/dev/null 2>&1; then
  FQDN=$(tailscale status --json 2>/dev/null | node -e \
    'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(((j.Self&&j.Self.DNSName)||"").replace(/\.$/,""))}catch{}})' \
    2>/dev/null)
fi

PASS=0
WARN=0
FAIL=0
report() { printf '  %-5s %s\n' "$1" "$2"; }
pass() {
  PASS=$((PASS + 1))
  report PASS "$1"
}
warn() {
  WARN=$((WARN + 1))
  report WARN "$1"
}
fail() {
  FAIL=$((FAIL + 1))
  report FAIL "$1"
}

# LAN module is present only when the caddy drop-in was installed.
LAN_ENABLED=false
[ -f /etc/systemd/system/caddy.service.d/evenhub.conf ] && LAN_ENABLED=true

echo ""
echo "EvenHub verification${FQDN:+ (origin: $FQDN)}"
echo ""

# --- 1. Service liveness ----------------------------------------------------
echo "Services:"
units="nanoclaw-evenhub-firewall nanoclaw-moonshine nanoclaw nanoclaw-tailscale-serve"
if [ "$LAN_ENABLED" = "true" ]; then
  units="$units caddy avahi-daemon"
fi
for u in $units; do
  if systemctl is-active --quiet "$u" 2>/dev/null; then
    pass "$u active"
  else
    fail "$u not active"
  fi
done

# --- 2. STT loopback --------------------------------------------------------
echo ""
echo "Endpoints:"
if curl --fail --silent --max-time 5 "http://127.0.0.1:${STT_PORT}/healthz" >/dev/null 2>&1; then
  pass "STT healthz (127.0.0.1:${STT_PORT})"
else
  fail "STT healthz (127.0.0.1:${STT_PORT}) unreachable"
fi

# --- 3. App loopback --------------------------------------------------------
if curl --fail --silent --max-time 5 \
  "http://127.0.0.1:${APP_PORT}/api/even/v1/healthz" >/dev/null 2>&1; then
  pass "app healthz (127.0.0.1:${APP_PORT})"
else
  fail "app healthz (127.0.0.1:${APP_PORT}) unreachable"
fi

# --- 4. Tailscale HTTPS origin ---------------------------------------------
if [ -n "$FQDN" ]; then
  if curl --fail --silent --max-time 8 \
    "https://${FQDN}/api/even/v1/healthz" >/dev/null 2>&1; then
    pass "origin healthz (https://${FQDN})"
  else
    fail "origin healthz (https://${FQDN}) unreachable"
  fi

  # readyz with the current protocol version. 503 that names only 'whatsapp'
  # is expected on a fresh install (no main channel registered yet) → warn.
  ready_body=$(curl --silent --max-time 8 -H 'X-EvenHub-Protocol-Version: 2' \
    "https://${FQDN}/api/even/v1/readyz" 2>/dev/null)
  ready_code=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 8 -H 'X-EvenHub-Protocol-Version: 2' \
    "https://${FQDN}/api/even/v1/readyz" 2>/dev/null)
  if [ "$ready_code" = "200" ]; then
    pass "origin readyz (protocol 2)"
  elif [ "$ready_code" = "503" ] && printf '%s' "$ready_body" | grep -q whatsapp &&
    ! printf '%s' "$ready_body" | grep -qE 'stt|gateway|moonshine'; then
    warn "origin readyz 503 (only 'whatsapp' unready — expected pre-registration)"
  else
    fail "origin readyz unexpected (code=$ready_code)"
  fi

  # A version-1 client must be refused with 426 Upgrade Required.
  v1_code=$(curl --silent --output /dev/null --write-out '%{http_code}' \
    --max-time 8 -H 'X-EvenHub-Protocol-Version: 1' \
    "https://${FQDN}/api/even/v1/readyz" 2>/dev/null)
  if [ "$v1_code" = "426" ]; then
    pass "protocol-version-1 rejected with 426"
  else
    fail "protocol-version-1 not rejected (code=$v1_code, expected 426)"
  fi
else
  warn "no tailnet FQDN resolved — skipped origin checks (pass --fqdn)"
fi

# --- 5. LAN / Caddy diagnostic path -----------------------------------------
if [ "$LAN_ENABLED" = "true" ]; then
  echo ""
  echo "LAN diagnostics:"
  lan_addr=""
  [ -r /etc/nanoclaw/evenhub-caddy.env ] &&
    lan_addr=$(sed -n 's/^NANOCLAW_LAN_ADDRESS=//p' /etc/nanoclaw/evenhub-caddy.env | head -n1)
  root_ca=/var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt
  if [ -n "$lan_addr" ] && [ -r "$root_ca" ]; then
    if curl --fail --silent --max-time 8 --cacert "$root_ca" \
      --resolve "nanoclaw.local:443:${lan_addr}" \
      "https://nanoclaw.local/api/even/v1/healthz" >/dev/null 2>&1; then
      pass "LAN healthz (https://nanoclaw.local via ${lan_addr})"
    else
      warn "LAN healthz unreachable (mDNS/cert/interface — diagnostic only)"
    fi
  else
    warn "LAN address or Caddy root CA not found — skipped LAN check"
  fi
fi

# --- 6. Network boundary ----------------------------------------------------
echo ""
echo "Boundary:"
if command -v ss >/dev/null 2>&1; then
  listeners=$(ss -lnt 2>/dev/null)
  bad=$(printf '%s\n' "$listeners" |
    awk -v a="$APP_PORT" -v s="$STT_PORT" '
      $4 ~ (":" a "$") || $4 ~ (":" s "$") {
        if ($4 !~ /^127\.0\.0\.1:/ && $4 !~ /^\[::1\]:/) print $4
      }')
  if [ -z "$bad" ]; then
    pass "app/STT ports listen on loopback only"
  else
    fail "app/STT ports exposed off-loopback: $(printf '%s' "$bad" | tr '\n' ' ')"
  fi
else
  warn "ss not available — skipped listener check"
fi

if command -v nft >/dev/null 2>&1; then
  if nft list table inet nanoclaw_evenhub >/dev/null 2>&1; then
    pass "nftables table inet nanoclaw_evenhub present"
  else
    fail "nftables table inet nanoclaw_evenhub missing (run as root?)"
  fi
else
  warn "nft not available — skipped firewall check"
fi

if command -v tailscale >/dev/null 2>&1; then
  serve=$(tailscale serve status 2>/dev/null || true)
  if printf '%s' "$serve" | grep -q "127.0.0.1:${APP_PORT}"; then
    pass "tailscale serve proxies 127.0.0.1:${APP_PORT}"
  else
    warn "tailscale serve does not show the app proxy (check manually)"
  fi
  funnel=$(tailscale funnel status 2>/dev/null || true)
  if printf '%s' "$funnel" | grep -qi "available on the internet"; then
    fail "tailscale FUNNEL is public — EvenHub must not be internet-exposed"
  else
    pass "tailscale funnel not public"
  fi
fi

# --- Summary ----------------------------------------------------------------
echo ""
echo "Summary: ${PASS} pass, ${WARN} warn, ${FAIL} fail"
[ "$FAIL" -eq 0 ]
