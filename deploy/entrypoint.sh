#!/bin/bash
set -e

# 1. Ensure /data directory exists (for SQLite database)
mkdir -p /data

# 2. Generate config.js with runtime credentials
PROXY_FLAG="false"
if [ -n "$PROXY_URL" ] || [ "$ENABLE_PROXY_RELAY" = "1" ] || [ "$ENABLE_PROXY_RELAY" = "true" ]; then
  PROXY_FLAG="true"
fi

mkdir -p /usr/share/nginx/html
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

# 3. Start Node.js Automation & Proxy Daemon in background
echo "Starting Interdivu Automation Daemon..."
node /app/server/index.mjs &
NODE_PID=$!

# Trap signals for graceful shutdown of both node and nginx
trap 'echo "Stopping services..."; kill -TERM $NODE_PID 2>/dev/null; nginx -s quit 2>/dev/null; wait $NODE_PID 2>/dev/null; exit 0' SIGTERM SIGINT

# 4. Start Nginx
echo "Starting Nginx..."
nginx -g 'daemon off;' &
NGINX_PID=$!

# Wait for either process to terminate
wait -n $NODE_PID $NGINX_PID
EXIT_CODE=$?

# If either process died, shut down the other and exit
kill -TERM $NODE_PID 2>/dev/null || true
nginx -s quit 2>/dev/null || true
exit $EXIT_CODE
