import { describe, expect, it } from 'vitest';

import type { ApiChat, ApiChatFullInfo } from '../../api/types';

import {
  classifyPromoChat, getIsPromoChatBlocked, getSlowmodeRemainingSeconds,
} from './classifyChat';

const SERVER_NOW = 1_000_000;

function buildChat(patch: Partial<ApiChat> = {}): ApiChat {
  return {
    id: '-1001234',
    type: 'chatTypeSuperGroup',
    title: 'Grupo de Divulgação',
    ...patch,
  };
}

function buildFullInfo(patch: Partial<ApiChatFullInfo> = {}): ApiChatFullInfo {
  return {
    ...patch,
  };
}

describe('getIsPromoChatBlocked', () => {
  it('blocks non-group chats', () => {
    expect(getIsPromoChatBlocked(buildChat({ type: 'chatTypeChannel' }))).toBe(true);
    expect(getIsPromoChatBlocked(buildChat({ type: 'chatTypePrivate' }))).toBe(true);
  });

  it('allows a regular supergroup', () => {
    expect(getIsPromoChatBlocked(buildChat())).toBe(false);
  });

  it('blocks by membership and restriction flags', () => {
    expect(getIsPromoChatBlocked(buildChat({ isForbidden: true }))).toBe(true);
    expect(getIsPromoChatBlocked(buildChat({ isNotJoined: true }))).toBe(true);
    expect(getIsPromoChatBlocked(buildChat({ isRestricted: true }))).toBe(true);
  });

  it('blocks by banned rights', () => {
    expect(getIsPromoChatBlocked(buildChat({
      currentUserBannedRights: { sendMessages: true },
    }))).toBe(true);
    expect(getIsPromoChatBlocked(buildChat({
      defaultBannedRights: { sendMessages: true },
    }))).toBe(true);
  });

  it('admin with post rights is never blocked', () => {
    expect(getIsPromoChatBlocked(buildChat({
      defaultBannedRights: { sendMessages: true },
      adminRights: { postMessages: true },
    }))).toBe(false);
  });
});

describe('getSlowmodeRemainingSeconds', () => {
  it('returns zero without slowmode configured', () => {
    expect(getSlowmodeRemainingSeconds(undefined, undefined, SERVER_NOW)).toBe(0);
    expect(getSlowmodeRemainingSeconds(buildFullInfo({ slowMode: { seconds: 0 } }), undefined, SERVER_NOW))
      .toBe(0);
  });

  it('uses server nextSendDate when in the future', () => {
    expect(getSlowmodeRemainingSeconds(
      buildFullInfo({ slowMode: { seconds: 300, nextSendDate: SERVER_NOW + 120 } }),
      undefined,
      SERVER_NOW,
    )).toBe(120);
  });

  it('ignores a past nextSendDate', () => {
    expect(getSlowmodeRemainingSeconds(
      buildFullInfo({ slowMode: { seconds: 300, nextSendDate: SERVER_NOW - 10 } }),
      undefined,
      SERVER_NOW,
    )).toBe(0);
  });

  it('derives the countdown from the last own message', () => {
    expect(getSlowmodeRemainingSeconds(
      buildFullInfo({ slowMode: { seconds: 600 } }),
      { lastOwnMessageAt: SERVER_NOW - 100 },
      SERVER_NOW,
    )).toBe(500);
  });

  it('picks the most restrictive signal', () => {
    expect(getSlowmodeRemainingSeconds(
      buildFullInfo({ slowMode: { seconds: 600, nextSendDate: SERVER_NOW + 60 } }),
      { lastOwnMessageAt: SERVER_NOW - 100 },
      SERVER_NOW,
    )).toBe(500);
  });

  it('returns zero when the own message is older than the slowmode window', () => {
    expect(getSlowmodeRemainingSeconds(
      buildFullInfo({ slowMode: { seconds: 600 } }),
      { lastOwnMessageAt: SERVER_NOW - 700 },
      SERVER_NOW,
    )).toBe(0);
  });
});

describe('classifyPromoChat', () => {
  it('classifies a plain group as free', () => {
    expect(classifyPromoChat(buildChat(), undefined, undefined, SERVER_NOW)).toBe('free');
  });

  it('classifies blocked chats as blocked regardless of other signals', () => {
    expect(classifyPromoChat(
      buildChat({
        currentUserBannedRights: { sendMessages: true },
        paidMessagesStars: 25,
      }),
      buildFullInfo({ slowMode: { seconds: 300, nextSendDate: SERVER_NOW + 100 } }),
      undefined,
      SERVER_NOW,
    )).toBe('blocked');
  });

  it('stars win over slowmode', () => {
    expect(classifyPromoChat(
      buildChat({ paidMessagesStars: 25 }),
      buildFullInfo({ slowMode: { seconds: 300, nextSendDate: SERVER_NOW + 100 } }),
      undefined,
      SERVER_NOW,
    )).toBe('stars');
  });

  it('classifies slowmode with an active countdown', () => {
    expect(classifyPromoChat(
      buildChat(),
      buildFullInfo({ slowMode: { seconds: 300, nextSendDate: SERVER_NOW + 100 } }),
      undefined,
      SERVER_NOW,
    )).toBe('slowmode');
  });

  it('classifies slowmode derived from the last own message', () => {
    expect(classifyPromoChat(
      buildChat(),
      buildFullInfo({ slowMode: { seconds: 300 } }),
      { lastOwnMessageAt: SERVER_NOW - 10 },
      SERVER_NOW,
    )).toBe('slowmode');
  });

  it('a group with slowmode configured but no active countdown is free', () => {
    expect(classifyPromoChat(
      buildChat(),
      buildFullInfo({ slowMode: { seconds: 300 } }),
      undefined,
      SERVER_NOW,
    )).toBe('free');
  });

  it('zero stars cost is free', () => {
    expect(classifyPromoChat(buildChat({ paidMessagesStars: 0 }), undefined, undefined, SERVER_NOW))
      .toBe('free');
  });
});
