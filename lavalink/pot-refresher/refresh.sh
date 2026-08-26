#!/bin/sh
set -eu

BGUTIL_URL="${BGUTIL_URL:-http://bgutil-provider.railway.internal:4416}"
LAVALINK_URL="${LAVALINK_URL:-http://lavalink.railway.internal:8080}"
REFRESH_INTERVAL="${POT_REFRESH_INTERVAL:-1800}"

case "$REFRESH_INTERVAL" in
  ''|*[!0-9]*) REFRESH_INTERVAL=1800 ;;
  0) REFRESH_INTERVAL=1800 ;;
esac

if [ -z "${LAVALINK_PASSWORD:-}" ]; then
  echo "[pot-refresher] LAVALINK_PASSWORD is required" >&2
  exit 1
fi

refresh() {
  response="$(curl -fsS --max-time 30 -X POST "$BGUTIL_URL/get_pot" \
    -H 'Content-Type: application/json' -d '{}')" || return 1

  pot="$(printf '%s' "$response" | jq -r '.poToken // empty')"
  visitor="$(printf '%s' "$response" | jq -r '.contentBinding // empty')"
  [ -n "$pot" ] && [ -n "$visitor" ] || return 1

  body="$(jq -nc --arg pot "$pot" --arg visitor "$visitor" \
    '{poToken:$pot, visitorData:$visitor}')"

  curl -fsS --max-time 30 -X POST "$LAVALINK_URL/youtube" \
    -H "Authorization: $LAVALINK_PASSWORD" \
    -H 'Content-Type: application/json' \
    -d "$body" >/dev/null || return 1

  echo "[pot-refresher] refreshed YouTube source token successfully"
}

echo "[pot-refresher] started; refresh interval=${REFRESH_INTERVAL}s"
while :; do
  if refresh; then
    sleep "$REFRESH_INTERVAL"
  else
    echo "[pot-refresher] refresh failed; retrying in 30s" >&2
    sleep 30
  fi
done
