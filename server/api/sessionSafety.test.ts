import { describe, expect, it, vi } from 'vitest';

import type { AutomationScheduler } from '../automation/scheduler';

import { SESSION_LAST_ALIVE_KEY, SESSION_USER_RELEASED_KEY, TelegramRunner } from '../automation/telegramRunner';
import { AutomationDatabase } from '../db/database';
import {
  BROWSER_PRESENCE_KEY, getSessionSafetyWaitSeconds, startAutomationFromSavedState, stopAutomation,
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
    expect(result.message).toContain('wait');
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

  it('refuses a remote start while a browser client holds the session', async () => {
    const { db, runner, scheduler } = createStack();
    db.saveStateJson(BROWSER_PRESENCE_KEY, { at: nowSeconds(), isClientConnected: true });
    const result = await startAutomationFromSavedState(db, runner, scheduler);
    expect(result.success).toBe(false);
    expect(result.message).toContain('web browser');
    expect(runner.start).not.toHaveBeenCalled();
    expect(scheduler.start).not.toHaveBeenCalled();
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
