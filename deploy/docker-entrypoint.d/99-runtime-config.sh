#!/bin/sh
set -e

# Rewrites the runtime credentials override consumed by the app at boot.
# Runs as part of the official nginx image entrypoint (/docker-entrypoint.d/*).

if [ -n "$TELEGRAM_API_ID" ] && [ -n "$TELEGRAM_API_HASH" ]; then
  printf 'window.__TELEGRAM_CREDS__ = { id: "%s", hash: "%s" };\n' \
    "$TELEGRAM_API_ID" \
    "$TELEGRAM_API_HASH" \
    > /usr/share/nginx/html/config.js
  echo "Runtime Telegram credentials applied."
else
  echo "TELEGRAM_API_ID/TELEGRAM_API_HASH are not set — using build-time credentials."
fi
