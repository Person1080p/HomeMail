#!/usr/bin/env bash
# Runs the end-to-end suites against a throwaway GreenMail container, starting a fresh
# HomeMail (empty data directory) on port $E2E_PORT (default 3311) for each suite.
#   scripts/e2e-greenmail.mjs  mail client features against IMAP/POP3/SMTP
#   scripts/e2e-server.mjs     built-in mail server, chat and server settings
#   scripts/e2e-stalwart.mjs   mailboxes on a bundled Stalwart server
#   scripts/e2e-xmpp.mjs       chat federation through Prosody
# Pass suite names to run only some, e.g.: scripts/e2e.sh e2e-xmpp
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${E2E_PORT:-3311}
SMTP_PORT=${E2E_SMTP_PORT:-2526}
CONTAINER=homemail-e2e-greenmail
STALWART=homemail-e2e-stalwart
PROSODY=homemail-e2e-prosody
DATA=""
SERVER=""
TMP=$(mktemp -d)
SUITES=("${@:-e2e-greenmail e2e-server e2e-stalwart e2e-xmpp}")
SUITES=(${SUITES[*]})

stop_homemail() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null && wait "$SERVER" 2>/dev/null || true
  SERVER=""
  [ -n "$DATA" ] && rm -rf "$DATA"
  DATA=""
}

cleanup() {
  stop_homemail
  docker rm -f "$CONTAINER" "$STALWART" "$PROSODY" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Extra environment for HomeMail comes as arguments: start_homemail VAR=value ...
start_homemail() {
  DATA=$(mktemp -d)
  (cd server && env DATA_DIR="$DATA" PORT="$PORT" AUTODETECT_ONLINE=false POP3_POLL_MINUTES=0 \
    MAIL_SERVER_MODE=builtin BUILTIN_SMTP_PORT="$SMTP_PORT" BUILTIN_SMTP_HOST=127.0.0.1 "$@" \
    node --import tsx src/index.ts) &
  SERVER=$!
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:$PORT/healthz" >/dev/null && return 0
    sleep 0.5
  done
  echo "HomeMail did not start" >&2
  return 1
}

wait_port() {
  for _ in $(seq 1 90); do
    (echo >/dev/tcp/127.0.0.1/"$1") 2>/dev/null && return 0
    sleep 0.5
  done
  echo "Port $1 did not open" >&2
  return 1
}

has_suite() { [[ " ${SUITES[*]} " == *" $1 "* ]]; }

if has_suite e2e-greenmail || has_suite e2e-server; then
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run -d --name "$CONTAINER" \
    -p 3025:3025 -p 3110:3110 -p 3143:3143 -p 3465:3465 -p 3993:3993 -p 3995:3995 \
    -e GREENMAIL_OPTS='-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=alice:alicepass@example.test,bob:bobpass@example.test -Dgreenmail.users.login=email' \
    greenmail/standalone:2.1.3 >/dev/null
  echo "Waiting for GreenMail..."
  wait_port 3993
fi

if has_suite e2e-stalwart; then
  docker rm -f "$STALWART" >/dev/null 2>&1 || true
  docker run -d --name "$STALWART" -e STALWART_RECOVERY_ADMIN=admin:Recovery-Secret-123 \
    -p 38080:8080 -p 30465:465 -p 30993:993 \
    -v "$PWD/deploy/stalwart/config.json:/etc/stalwart/config.json:ro" stalwartlabs/stalwart:v0.16.23 >/dev/null
  echo "Waiting for Stalwart..."
  wait_port 38080 && sleep 3
fi

if has_suite e2e-xmpp; then
  # The production Prosody config plus a local test domain standing in for "another server".
  sed -e 's/^c2s_ports = { }/c2s_ports = { 5222 }\nc2s_require_encryption = false\nallow_unencrypted_plain_auth = true/' \
      -e 's/^Include .*$//' deploy/prosody/prosody.cfg.lua > "$TMP/prosody.cfg.lua"
  printf '\nVirtualHost "other.test"\n\tmodules_enabled = { "roster"; "saslauth"; "presence" }\n\tmodules_disabled = { "tls" }\n' >> "$TMP/prosody.cfg.lua"
  chmod a+r "$TMP/prosody.cfg.lua"
  docker rm -f "$PROSODY" >/dev/null 2>&1 || true
  docker run -d --name "$PROSODY" -p 15347:5347 -p 15222:5222 \
    -e HOMEMAIL_CHAT_DOMAIN=home.mail -e HOMEMAIL_COMPONENT_SECRET=e2e-secret -e PROSODY_S2S_SECURE_AUTH=0 \
    -e LOCAL=dave -e DOMAIN=other.test -e PASSWORD=davepass \
    -v "$TMP/prosody.cfg.lua:/etc/prosody/prosody.cfg.lua:ro" prosodyim/prosody:13.0 >/dev/null
  echo "Waiting for Prosody..."
  wait_port 15347 && sleep 2
fi

status=0
for suite in "${SUITES[@]}"; do
  echo "=== $suite"
  case $suite in
    e2e-stalwart)
      start_homemail MAIL_SERVER_MODE=stalwart STALWART_URL=http://127.0.0.1:38080 STALWART_ADMIN=admin:Recovery-Secret-123 \
        STALWART_IMAP_HOST=127.0.0.1 STALWART_IMAP_PORT=30993 STALWART_SMTP_PORT=30465 MAIL_DOMAIN=home.internal BUILTIN_SMTP_PORT=0 ;;
    e2e-xmpp)
      start_homemail MAIL_SERVER_MODE=off XMPP_COMPONENT_SERVICE=xmpp://127.0.0.1:15347 XMPP_COMPONENT_SECRET=e2e-secret CHAT_FEDERATION=true BUILTIN_SMTP_PORT=0 ;;
    *) start_homemail ;;
  esac
  BASE="http://localhost:$PORT" BUILTIN_SMTP_PORT="$SMTP_PORT" node "scripts/$suite.mjs" || status=1
  stop_homemail
done
exit $status
