import { describe, expect, it } from 'vitest';

import {
  calculateJitterDelayMs,
  evaluateGroupEligibility,
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

describe('evaluateGroupEligibility', () => {
  const now = 1_000_000;

  it('declares group ready when conditions are met after previous send', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 3600,
      otherMessagesCount: 5,
      slowmodeSeconds: 60,
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
      lastSentAt: now - 3600,
      otherMessagesCount: 3, // less than 5
      slowmodeSeconds: 60,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe('WAITING_MESSAGES');
  });

  it('blocks group waiting for slowmode countdown', () => {
    const result = evaluateGroupEligibility({
      chatId: '-1',
      title: 'Grupo A',
      lastSentAt: now - 100,
      otherMessagesCount: 10,
      slowmodeSeconds: 600,
      slowmodeNextSendDate: now + 300,
      status: 'READY',
      updatedAt: now,
    }, 5, now);

    expect(result.isEligible).toBe(false);
    expect(result.reason).toBe('WAITING_SLOWMODE');
  });
});
