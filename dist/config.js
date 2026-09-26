// Runtime Telegram credentials override.
// The Docker image entrypoint rewrites this file from the TELEGRAM_API_ID and
// TELEGRAM_API_HASH environment variables when the container starts, so the
// published image stays credential-free. Left empty, the app falls back to the
// credentials baked at build time.
