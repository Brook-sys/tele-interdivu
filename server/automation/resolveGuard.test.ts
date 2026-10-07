import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FloodWaitActiveError, parseFloodWaitSeconds, ResolveGuard } from './resolveGuard';

const buildFloodError = (seconds: number) => ({ code: 420, errorMessage: `FLOOD_WAIT_${seconds}` });

describe('parseFloodWaitSeconds', () => {
  it('extracts the wait from GramJS flood errors', () => {
    expect(parseFloodWaitSeconds(buildFloodError(1072))).toBe(1072);
    expect(parseFloodWaitSeconds({ errorMessage: 'FLOOD_WAIT_1' })).toBe(1);
  });

  it('ignores non-flood errors', () => {
    expect(parseFloodWaitSeconds(new Error('SOME_OTHER_ERROR'))).toBeUndefined();
    expect(parseFloodWaitSeconds(buildFloodError(0))).toBeUndefined();
    expect(parseFloodWaitSeconds(undefined)).toBeUndefined();
  });

  it('falls back to scanning the error message text', () => {
    expect(parseFloodWaitSeconds(
      new Error('RPCError 420: FLOOD_WAIT_1072 (caused by messages.CheckChatInvite)'),
    )).toBe(1072);
  });
});

describe('ResolveGuard flood gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks resolutions while the window is active and clears afterwards', () => {
    const guard = new ResolveGuard(0, 0);

    expect(guard.registerFlood(buildFloodError(5))).toBe(5);
    expect(() => guard.assertNotFlooded()).toThrow(FloodWaitActiveError);

    vi.advanceTimersByTime(6_000);
    expect(() => guard.assertNotFlooded()).not.toThrow();
  });

  it('keeps the longest window when flooded again', () => {
    const guard = new ResolveGuard(0, 0);

    guard.registerFlood(buildFloodError(60));
    vi.advanceTimersByTime(30_000);
    guard.registerFlood(buildFloodError(60));

    expect(guard.getRemainingFloodSeconds()).toBe(60);
  });

  it('serves cached results during a flood window', () => {
    const guard = new ResolveGuard(0, 60_000);

    guard.store('invite:abc', { title: 'Test' });
    guard.registerFlood(buildFloodError(600));

    expect(guard.getCached('invite:abc')).toEqual({ title: 'Test' });
    expect(() => guard.assertNotFlooded()).toThrow(FloodWaitActiveError);
  });

  it('expires cache entries after the TTL', () => {
    const guard = new ResolveGuard(0, 1000);

    guard.store('invite:abc', { title: 'Test' });
    expect(guard.getCached('invite:abc')).toEqual({ title: 'Test' });

    vi.advanceTimersByTime(1_500);
    expect(guard.getCached('invite:abc')).toBeUndefined();
  });
});

describe('ResolveGuard pacing', () => {
  it('keeps a human-like interval between consecutive calls', async () => {
    const guard = new ResolveGuard(40, 0);
    const startedAt = Date.now();

    await guard.awaitPace();
    await guard.awaitPace();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
  });

  it('reports a friendly wait estimate in the error message', () => {
    expect(new FloodWaitActiveError(1072).message).toMatch(/18 min/);
  });
});
