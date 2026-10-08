import { describe, expect, it } from 'vitest';

import {
  AutomationScheduler,
  buildCooldownWaitReason,
  calculateJitterDelayMs,
  evaluateGroupEligibility,
  getSleepWindowEndMs,
  isInsideSleepWindow,
} from './scheduler';

describe('isInsideSleepWindow', () => {
  it('correctly detects time within standard daytime window', () => {
    const testDate = new Date('2026-09-25T14:30:00'); // 14:30
    expect(isInsideSleepWindow('14:00', '15:00', testDate)).toBe(true);
    expect(isInsideSleepWindow('15:00', '16:00', testDate)).toBe(false);
  });

  it('correctly handles overnight windows crossing midnight', () => {
    const nightDate = new Date('2026-09-25T02:30:00'); // 02:30
    const eveningDate = new Date('2026-09-25T23:45:00'); // 23:45
    const afternoonDate = new Date('2026-09-25T14:00:00'); // 14:00

    expect(isInsideSleepWindow('23:30', '07:30', nightDate)).toBe(true);
    expect(isInsideSleepWindow('23:30', '07:30', eveningDate)).toBe(true);
    expect(isInsideSleepWindow('23:30', '07:30', afternoonDate)).toBe(false);
  });
});

describe('calculateJitterDelayMs', () => {
  it('generates values within the requested range', () => {
    for (let i = 0; i < 50; i++) {
      const ms = calculateJitterDelayMs(10, 20);
      expect(ms).toBeGreaterThanOrEqual(10_000);
      expect(ms).toBeLessThanOrEqual(20_000);
    }
  });
});

describe('buildCooldownWaitReason', () => {
  it('mentions the next group and its cooldown estimate', () => {
    expect(buildCooldownWaitReason('Grupo X', 120, 0, 12))
      .toBe('Aguardando cooldown de Grupo X (~120s)');
  });

  it('discloses groups still blocked by the other-messages rule', () => {
    expect(buildCooldownWaitReason('Grupo X', 45, 3, 12))
      .toBe('Aguardando cooldown de Grupo X (~45s) · 3 grupo(s) aguardando 12+ mensagens de terceiros');
  });

  it('never reports negative countdowns', () => {
    expect(buildCooldownWaitReason('Grupo X', -10, 0, 12))
      .toBe('Aguardando cooldown de Grupo X (~0s)');
  });
});

describe('evaluateGroupEligibility', () => {
  const now = 1_000_000;

  it('declares group ready when conditions are met after previous send', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 3600,
      otherMessagesCount: 5,
      slowmodeSeconds: 60,
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(true);
    expect(result.reason).toBe('READY');
  });

  it('allows sending for the first time if group has never been sent to', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: undefined, // never sent yet
      otherMessagesCount: 0,
      slowmodeSeconds: 60,
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(true);
    expect(result.reason).toBe('READY');
  });

  it('blocks group waiting for other messages when previously sent', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 3600, // 1 hour ago
      otherMessagesCount: 3, // less than 5
      slowmodeSeconds: 60,
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe('WAITING_MESSAGES');
  });

  it('strictly blocks group waiting for messages regardless of how long ago it was sent', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - (24 * 3600), // 24 hours ago
      otherMessagesCount: 4, // less than 5 (strict: requires 5)
      slowmodeSeconds: 60,
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe('WAITING_MESSAGES');
  });

  it('allows re-sending to previously sent group when both slowmode and other messages are met', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 600, // 10 minutes ago
      otherMessagesCount: 15, // more than 5!
      slowmodeSeconds: 60, // slowmode was 60s, 600s elapsed
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(true);
    expect(result.reason).toBe('READY');
  });

  it('blocks re-send within minResendIntervalMinutes even when other criteria are met', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 300, // 5 minutes ago
      otherMessagesCount: 15,
      slowmodeSeconds: 60,
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now, 10); // min 10 min between re-sends

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe('WAITING_RESEND');
  });

  it('allows re-send after minResendIntervalMinutes elapses', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 660, // 11 minutes ago
      otherMessagesCount: 15,
      slowmodeSeconds: 60,
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now, 10);

    expect(result.isEligible).toBe(true);
    expect(result.reason).toBe('READY');
  });

  it('disables resend floor when minResendIntervalMinutes is 0', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 70,
      otherMessagesCount: 15,
      slowmodeSeconds: 60,
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now, 0);

    expect(result.isEligible).toBe(true);
    expect(result.reason).toBe('READY');
  });

  it('blocks group waiting for slowmode countdown', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 100,
      otherMessagesCount: 10,
      slowmodeSeconds: 600,
      slowmodeNextSendDate: now + 300,
      starsCost: 0,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe('WAITING_SLOWMODE');
  });

  it('strictly rejects groups that charge Stars', () => {
    const withCost = evaluateGroupEligibility({
      chatId: '-2',
      title: 'Grupo Estrelas',
      otherMessagesCount: 10,
      slowmodeSeconds: 0,
      starsCost: 20,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(withCost.isEligible).toBe(false);
    expect(withCost.reason).toBe('STARS');

    const withStatus = evaluateGroupEligibility({
      chatId: '-3',
      title: 'Grupo Estrelas 2',
      otherMessagesCount: 10,
      slowmodeSeconds: 0,
      starsCost: 0,
      status: 'STARS',
      updatedAt: now,
    }, 5, now);

    expect(withStatus.isEligible).toBe(false);
    expect(withStatus.reason).toBe('STARS');
  });

  it('strictly rejects blocked groups', () => {
    const result = evaluateGroupEligibility({
      chatId: '-4',
      title: 'Grupo Bloqueado',
      otherMessagesCount: 10,
      slowmodeSeconds: 0,
      starsCost: 0,
      status: 'BLOCKED',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe('BLOCKED');
  });
});

describe('quarantine revalidation', () => {
  function createDbStub(groups: any[]) {
    const upserts: any[] = [];
    const logs: any[] = [];
    const db = {
      getAllGroupStates: () => groups,
      upsertGroupState: (r: any) => upserts.push(r),
      addLog: (l: any) => logs.push(l),
    };

    return { db, upserts, logs };
  }

  function createScheduler(db: any, probe: (chatId: string) => Promise<any>) {
    return new AutomationScheduler(db, () => Promise.resolve({ success: true }), undefined, probe);
  }

  it('reintegrates a stars group when the probe reports it is free again', async () => {
    const group = {
      chatId: '-1', title: 'Grupo Estrelas', otherMessagesCount: 3, slowmodeSeconds: 60,
      starsCost: 20, status: 'STARS', lastSentAt: 1, updatedAt: 1,
    };
    const { db, upserts } = createDbStub([group]);
    const scheduler = createScheduler(db, () => Promise.resolve({ canWrite: true, starsCost: 0, slowmodeSeconds: 30 }));

    await (scheduler as any).revalidateQuarantinedGroups(new AbortController().signal);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].status).toBe('READY');
    expect(upserts[0].starsCost).toBe(0);
    expect(upserts[0].slowmodeSeconds).toBe(30);
  });

  it('marks a stars group as blocked when the probe says the channel is inaccessible', async () => {
    const group = {
      chatId: '-2', title: 'Grupo X', otherMessagesCount: 0, slowmodeSeconds: 0,
      starsCost: 50, status: 'STARS', updatedAt: 1,
    };
    const { db, upserts } = createDbStub([group]);
    const scheduler = createScheduler(db, () => Promise.resolve({ canWrite: false }));

    await (scheduler as any).revalidateQuarantinedGroups(new AbortController().signal);

    expect(upserts).toHaveLength(1);
    expect(upserts[0].status).toBe('BLOCKED');
  });

  it('updates the stars price and keeps quarantine when the group still charges', async () => {
    const group = {
      chatId: '-3', title: 'Grupo Y', otherMessagesCount: 0, slowmodeSeconds: 0,
      starsCost: 10, status: 'STARS', updatedAt: 1,
    };
    const { db, upserts } = createDbStub([group]);
    let calls = 0;
    const scheduler = createScheduler(db, async () => {
      calls++;
      await Promise.resolve();
      return { canWrite: true, starsCost: 99 };
    });

    await (scheduler as any).revalidateQuarantinedGroups(new AbortController().signal);
    await (scheduler as any).revalidateQuarantinedGroups(new AbortController().signal);

    expect(calls).toBe(1); // throttled by REVALIDATE_INTERVAL_MS
    expect(upserts[0].status).toBe('STARS');
    expect(upserts[0].starsCost).toBe(99);
  });

  it('skips revalidation when probe callback is unavailable', async () => {
    const group = {
      chatId: '-4', title: 'Grupo Z', otherMessagesCount: 0, slowmodeSeconds: 0,
      starsCost: 5, status: 'STARS', updatedAt: 1,
    };
    const { db, upserts } = createDbStub([group]);
    const scheduler = new AutomationScheduler(db as any, () => Promise.resolve({ success: true }));

    await (scheduler as any).revalidateQuarantinedGroups(new AbortController().signal);

    expect(upserts).toHaveLength(0);
  });
});

describe('getSleepWindowEndMs', () => {
  it('returns today end when inside a same-day window', () => {
    const now = new Date('2026-09-25T14:30:00');
    const end = getSleepWindowEndMs('14:00', '15:00', now);
    expect(end).toBe(new Date('2026-09-25T15:00:00').getTime());
  });

  it('returns next-day end when inside an overnight window after midnight crossing', () => {
    const now = new Date('2026-09-25T23:45:00');
    const end = getSleepWindowEndMs('23:30', '07:30', now);
    expect(end).toBe(new Date('2026-09-26T07:30:00').getTime());
  });

  it('returns today end when inside an overnight window before midnight', () => {
    const now = new Date('2026-09-26T03:00:00');
    const end = getSleepWindowEndMs('23:30', '07:30', now);
    expect(end).toBe(new Date('2026-09-26T07:30:00').getTime());
  });

  it('returns undefined outside the window', () => {
    const now = new Date('2026-09-25T16:00:00');
    expect(getSleepWindowEndMs('14:00', '15:00', now)).toBeUndefined();
  });
});
