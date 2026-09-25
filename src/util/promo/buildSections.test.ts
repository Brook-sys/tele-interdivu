import { describe, expect, it } from 'vitest';

import type { ApiChat, ApiChatFullInfo } from '../../api/types';
import type { PromoChatStatus, PromoSettings } from '../../global/types/promo';
import { DEFAULT_PROMO_SETTINGS } from '../../global/types/promo';

import { buildPromoSections } from './buildSections';

const SERVER_NOW = 1_000_000;
const LOCALE = 'pt-BR';

function buildChat(id: string, patch: Partial<ApiChat> = {}): ApiChat {
  return {
    id,
    type: 'chatTypeSuperGroup',
    title: `Grupo ${id}`,
    ...patch,
  };
}

function buildParams({
  orderedChatIds,
  chatsById,
  fullInfoById = {},
  statusById = {},
  settings = DEFAULT_PROMO_SETTINGS,
  serverNow = SERVER_NOW,
}: {
  orderedChatIds: string[];
  chatsById: Record<string, ApiChat>;
  fullInfoById?: Record<string, ApiChatFullInfo>;
  statusById?: Record<string, PromoChatStatus>;
  settings?: PromoSettings;
  serverNow?: number;
}) {
  return {
    orderedChatIds,
    chatsById,
    fullInfoById,
    statusById,
    categoryOrder: settings.categoryOrder,
    sortCriteriaByCategoryId: settings.sortCriteriaByCategoryId,
    serverNow,
    locale: LOCALE,
  };
}

describe('buildPromoSections', () => {
  it('buckets chats into the three fixed categories', () => {
    const chats = {
      free: buildChat('a'),
      slow: buildChat('b', {}),
      stars: buildChat('c', { paidMessagesStars: 10 }),
    };
    const sections = buildPromoSections(buildParams({
      orderedChatIds: ['stars', 'free', 'slow'],
      chatsById: chats,
      fullInfoById: {
        slow: { slowMode: { seconds: 300, nextSendDate: SERVER_NOW + 100 } },
      },
    }));

    expect(sections).toHaveLength(3);
    expect(sections[0]).toEqual({ categoryId: 'free', chatIds: ['free'] });
    expect(sections[1]).toEqual({ categoryId: 'slowmode', chatIds: ['slow'] });
    expect(sections[2]).toEqual({ categoryId: 'stars', chatIds: ['stars'] });
  });

  it('excludes blocked chats', () => {
    const sections = buildPromoSections(buildParams({
      orderedChatIds: ['blocked', 'free'],
      chatsById: {
        blocked: buildChat('blocked', { isNotJoined: true }),
        free: buildChat('free'),
      },
    }));

    expect(sections[0].chatIds).toEqual(['free']);
  });

  it('respects the configured section order', () => {
    const sections = buildPromoSections(buildParams({
      orderedChatIds: ['a', 'b'],
      chatsById: { a: buildChat('a'), b: buildChat('b') },
      settings: {
        ...DEFAULT_PROMO_SETTINGS,
        categoryOrder: ['stars', 'free', 'slowmode'],
      },
    }));

    expect(sections.map(({ categoryId }) => categoryId)).toEqual(['stars', 'free', 'slowmode']);
  });

  it('sorts by stars cost ascending with a title tie-break', () => {
    const sections = buildPromoSections(buildParams({
      orderedChatIds: ['cheap', 'expensive', 'free1'],
      chatsById: {
        expensive: buildChat('expensive', { paidMessagesStars: 100, title: 'Zz Group' }),
        cheap: buildChat('cheap', { paidMessagesStars: 5, title: 'Aa Group' }),
        free1: buildChat('free1', { paidMessagesStars: 5, title: 'Ab Group' }),
      },
    }));

    expect(sections[2].chatIds).toEqual(['cheap', 'free1', 'expensive']);
  });

  it('sorts by slowmode remaining ascending', () => {
    const sections = buildPromoSections(buildParams({
      orderedChatIds: ['long', 'short'],
      chatsById: {
        long: buildChat('long'),
        short: buildChat('short'),
      },
      fullInfoById: {
        long: { slowMode: { seconds: 1000, nextSendDate: SERVER_NOW + 500 } },
        short: { slowMode: { seconds: 1000, nextSendDate: SERVER_NOW + 10 } },
      },
    }));

    expect(sections[1].chatIds).toEqual(['short', 'long']);
  });

  it('skips ids missing from the chat cache', () => {
    const sections = buildPromoSections(buildParams({
      orderedChatIds: ['missing', 'free'],
      chatsById: { free: buildChat('free') },
    }));

    expect(sections[0].chatIds).toEqual(['free']);
  });
});
