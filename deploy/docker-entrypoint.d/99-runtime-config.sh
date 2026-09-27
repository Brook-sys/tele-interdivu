#!/bin/sh
set -e

# Rewrites the runtime credentials override consumed by the app at boot.
# Runs as part of the official nginx image entrypoint (/docker-entrypoint.d/*).

PROXY_FLAG="false"
if [ -n "$PROXY_URL" ] || [ "$ENABLE_PROXY_RELAY" = "1" ] || [ "$ENABLE_PROXY_RELAY" = "true" ]; then
  PROXY_FLAG="true"
fi

if [ -n "$TELEGRAM_API_ID" ] && [ -n "$TELEGRAM_API_HASH" ]; then
  printf 'window.__TELEGRAM_CREDS__ = { id: "%s", hash: "%s", isProxyEnabled: %s };\n' \
    "$TELEGRAM_API_ID" \
    "$TELEGRAM_API_HASH" \
    "$PROXY_FLAG" \
    > /usr/share/nginx/html/config.js
  echo "Runtime Telegram credentials applied (isProxyEnabled: $PROXY_FLAG)."
else
  printf 'window.__TELEGRAM_CREDS__ = { isProxyEnabled: %s };\n' \
    "$PROXY_FLAG" \
    > /usr/share/nginx/html/config.js
  echo "TELEGRAM_API_ID/TELEGRAM_API_HASH are not set — using build-time credentials (isProxyEnabled: $PROXY_FLAG)."
fi
