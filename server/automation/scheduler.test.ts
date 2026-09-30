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
