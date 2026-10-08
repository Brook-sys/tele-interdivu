import { describe, expect, it, vi } from 'vitest';

import type { AutomationScheduler } from '../automation/scheduler';

import { SESSION_LAST_ALIVE_KEY, SESSION_USER_RELEASED_KEY, TelegramRunner } from '../automation/telegramRunner';
import { AutomationDatabase } from '../db/database';
import {
  BROWSER_PRESENCE_KEY, buildSessionFingerprint, buildStatusPayload, getSessionSafetyWaitSeconds,
  startAutomationFromSavedState, stopAutomation,
} from './routes';

function createStack() {
  const db = new AutomationDatabase(':memory:');
  db.saveSession('{}');
  db.upsertGroupState({
    chatId: '-1001234567890',
    title: 'Test Group',
    accessHash: '1',
    otherMessagesCount: 0,
    slowmodeSeconds: 0,
    starsCost: 0,
    lastSentAt: 0,
    status: 'READY',
  });
  const runner = new TelegramRunner(db);
  vi.spyOn(runner, 'start').mockResolvedValue(undefined);
  vi.spyOn(runner, 'getIsConnected').mockReturnValue(false);
  const scheduler = {
    start: vi.fn(),
    stop: vi.fn(),
    getState: vi.fn(() => ({ status: 'STOPPED' })),
  } as unknown as AutomationScheduler;
  return { db, runner, scheduler };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

describe('session safety cooldown', () => {
  it('reports no wait without markers', () => {
    const { db } = createStack();
    expect(getSessionSafetyWaitSeconds(db, false)).toBe(0);
  });

  it('ignores the window while the daemon holds the session', () => {
    const { db } = createStack();
    db.saveStateJson(SESSION_LAST_ALIVE_KEY, nowSeconds());
    expect(getSessionSafetyWaitSeconds(db, false)).toBeGreaterThan(0);
    expect(getSessionSafetyWaitSeconds(db, true)).toBe(0);
  });

  it('waits after an abrupt end and clears after a user release', () => {
    const { db } = createStack();
    db.saveStateJson(SESSION_LAST_ALIVE_KEY, nowSeconds());
    expect(getSessionSafetyWaitSeconds(db, false)).toBeGreaterThan(0);
    db.saveStateJson(SESSION_USER_RELEASED_KEY, nowSeconds());
    expect(getSessionSafetyWaitSeconds(db, false)).toBe(0);
  });

  it('expires the window after the cooldown', () => {
    const { db } = createStack();
    db.saveStateJson(SESSION_LAST_ALIVE_KEY, nowSeconds() - 200);
    expect(getSessionSafetyWaitSeconds(db, false)).toBe(0);
  });

  it('refuses to start from saved state inside the window', async () => {
    const { db, runner, scheduler } = createStack();
    db.saveStateJson(SESSION_LAST_ALIVE_KEY, nowSeconds());
    const result = await startAutomationFromSavedState(db, runner, scheduler);
    expect(result.success).toBe(false);
    expect(result.message).toContain('aguarde');
    expect(runner.start).not.toHaveBeenCalled();
    expect(scheduler.start).not.toHaveBeenCalled();
  });

  it('starts from saved state once the window has expired', async () => {
    const { db, runner, scheduler } = createStack();
    db.saveStateJson(SESSION_LAST_ALIVE_KEY, nowSeconds() - 200);
    const result = await startAutomationFromSavedState(db, runner, scheduler);
    expect(result.success).toBe(true);
    expect(result.groupsCount).toBe(1);
    expect(runner.start).toHaveBeenCalledTimes(1);
    expect(scheduler.start).toHaveBeenCalledTimes(1);
  });

  it('maps AUTH_KEY_DUPLICATED to a clear failure without starting the scheduler', async () => {
    const { db, runner, scheduler } = createStack();
    vi.spyOn(runner, 'start').mockRejectedValue(new Error('406 AUTH_KEY_DUPLICATED'));
    const result = await startAutomationFromSavedState(db, runner, scheduler);
    expect(result.success).toBe(false);
    expect(result.message).toContain('AUTH_KEY_DUPLICATED');
    expect(scheduler.start).not.toHaveBeenCalled();
  });

  it('ends the window after a user release through stopAutomation', async () => {
    const { db, runner, scheduler } = createStack();
    db.saveStateJson(SESSION_LAST_ALIVE_KEY, nowSeconds());
    expect(getSessionSafetyWaitSeconds(db, false)).toBeGreaterThan(0);
    await stopAutomation(db, runner, scheduler);
    expect(getSessionSafetyWaitSeconds(db, false)).toBe(0);
  });

  it('refuses a remote start when the browser never yields the session', async () => {
    vi.useFakeTimers();
    try {
      const { db, runner, scheduler } = createStack();
      db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds(), isClientConnected: true });
      const promise = startAutomationFromSavedState(db, runner, scheduler);
      await vi.advanceTimersByTimeAsync(13_000);
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.message).toContain('não liberou');
      expect(result.message).toContain('painel da própria conta');
      expect(runner.start).not.toHaveBeenCalled();
      expect(scheduler.start).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('publishes the pending-start marker in the status while waiting for the yield', async () => {
    vi.useFakeTimers();
    try {
      const { db, runner, scheduler } = createStack();
      db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds(), isClientConnected: true });
      const promise = startAutomationFromSavedState(db, runner, scheduler);
      await vi.advanceTimersByTimeAsync(1_500);
      expect(buildStatusPayload(db, runner, scheduler).browserPendingStart).toBe(true);
      await vi.advanceTimersByTimeAsync(12_000);
      await promise;
      expect(buildStatusPayload(db, runner, scheduler).browserPendingStart).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts remotely once the browser tab yields during the handshake', async () => {
    vi.useFakeTimers();
    try {
      const { db, runner, scheduler } = createStack();
      db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds(), isClientConnected: true });
      const promise = startAutomationFromSavedState(db, runner, scheduler);
      await vi.advanceTimersByTimeAsync(2_500);
      // The tab hands the session over on its next presence beat
      db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds(), isClientConnected: false });
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(runner.start).toHaveBeenCalledTimes(1);
      expect(scheduler.start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses immediately when the saved session no longer matches the browser one', async () => {
    const { db, runner, scheduler } = createStack();
    db.saveSession(JSON.stringify({ mainDcId: 2, keys: { 2: 'saved-key' } }));
    db.saveStateJson(BROWSER_PRESENCE_KEY, {
      at: nowSeconds(),
      isClientConnected: true,
      sessionFingerprint: 'stale-fingerprint',
    });
    const result = await startAutomationFromSavedState(db, runner, scheduler);
    expect(result.success).toBe(false);
    expect(result.message).toContain('não corresponde');
    expect(result.message).toContain('Iniciar');
    expect(runner.start).not.toHaveBeenCalled();
    expect(scheduler.start).not.toHaveBeenCalled();
  });

  it('starts remotely when the fingerprints match and the tab yields', async () => {
    vi.useFakeTimers();
    try {
      const { db, runner, scheduler } = createStack();
      db.saveSession(JSON.stringify({ mainDcId: 2, keys: { 2: 'saved-key' } }));
      const fingerprint = buildSessionFingerprint({ keys: { 2: 'saved-key' } });
      db.saveStateJson(BROWSER_PRESENCE_KEY, {
        at: nowSeconds(),
        isClientConnected: true,
        sessionFingerprint: fingerprint,
      });
      const promise = startAutomationFromSavedState(db, runner, scheduler);
      await vi.advanceTimersByTimeAsync(2_500);
      db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds(), isClientConnected: false });
      await vi.advanceTimersByTimeAsync(1_500);
      const result = await promise;
      expect(result.success).toBe(true);
      expect(runner.start).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('allows a coordinated handover (takeover with sessionData) with the browser connected', async () => {
    const { db, runner, scheduler } = createStack();
    db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds(), isClientConnected: true });
    const result = await startAutomationFromSavedState(db, runner, scheduler, {
      isCoordinatedHandover: true,
    });
    expect(result.success).toBe(true);
    expect(runner.start).toHaveBeenCalledTimes(1);
  });

  it('allows a remote start once the browser presence is stale', async () => {
    const { db, runner, scheduler } = createStack();
    db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds() - 121, isClientConnected: true });
    const result = await startAutomationFromSavedState(db, runner, scheduler);
    expect(result.success).toBe(true);
  });

  it('allows a remote start when the browser reports itself disconnected', async () => {
    const { db, runner, scheduler } = createStack();
    db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds(), isClientConnected: false });
    const result = await startAutomationFromSavedState(db, runner, scheduler);
    expect(result.success).toBe(true);
  });
});
