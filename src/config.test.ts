import { afterEach, describe, expect, it, vi } from 'vitest';

describe('runtime telegram credentials (src/config.ts)', () => {
  afterEach(() => {
    delete window.__TELEGRAM_CREDS__;
    vi.resetModules();
  });

  it('prefers the runtime override', async () => {
    window.__TELEGRAM_CREDS__ = { id: 98765, hash: 'fedcba' };

    const config = await import('./config');

    expect(config.TELEGRAM_API_ID).toBe(98765);
    expect(config.TELEGRAM_API_HASH).toBe('fedcba');
  });

  it('accepts string ids from the runtime override', async () => {
    window.__TELEGRAM_CREDS__ = { id: '55555', hash: 'abc' };

    const config = await import('./config');

    expect(config.TELEGRAM_API_ID).toBe(55555);
  });

  it('falls back to build-time credentials without an override', async () => {
    const config = await import('./config');

    // `TG_TELEGRAM_API_ID` is an empty string under vitest, which documents the fallback path
    expect(config.TELEGRAM_API_ID).toBe(0);
    expect(config.TELEGRAM_API_HASH).toBe('');
  });
});
