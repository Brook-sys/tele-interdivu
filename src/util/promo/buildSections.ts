import type { ApiChat, ApiChatFullInfo } from '../../api/types';
import type {
  PromoCategoryId, PromoChatStatus, PromoSortCriteria,
} from '../../global/types/promo';

import { classifyPromoChat, getSlowmodeRemainingSeconds } from './classifyChat';

export const PROMO_SECTION_IDS: PromoCategoryId[] = ['free', 'slowmode', 'stars'];

export interface PromoSectionData {
  categoryId: PromoCategoryId;
  chatIds: string[];
}

interface BuildSectionsParams {
  orderedChatIds: string[];
  chatsById: Record<string, ApiChat>;
  fullInfoById: Record<string, ApiChatFullInfo>;
  statusById: Record<string, PromoChatStatus>;
  categoryOrder: PromoCategoryId[];
  sortCriteriaByCategoryId: Record<PromoCategoryId, PromoSortCriteria>;
  serverNow: number;
  locale: string;
}

const collatorsByLocale = new Map<string, Intl.Collator>();

function getCollator(locale: string) {
  let collator = collatorsByLocale.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { sensitivity: 'base' });
    collatorsByLocale.set(locale, collator);
  }
  return collator;
}

function compareTitles(params: BuildSectionsParams, a: string, b: string) {
  return getCollator(params.locale).compare(params.chatsById[a]?.title || '', params.chatsById[b]?.title || '');
}

function getNumericSortValue(
  chatId: string,
  criteria: PromoSortCriteria,
  params: BuildSectionsParams,
): number {
  if (criteria === 'starsCost') {
    return params.chatsById[chatId]?.paidMessagesStars || 0;
  }

  return getSlowmodeRemainingSeconds(
    params.fullInfoById[chatId],
    params.statusById[chatId],
    params.serverNow,
  );
}

export function buildPromoSections(params: BuildSectionsParams): PromoSectionData[] {
  const {
    orderedChatIds, chatsById, fullInfoById, statusById,
    categoryOrder, sortCriteriaByCategoryId, serverNow,
  } = params;

  const chatIdsByCategory = new Map<PromoCategoryId, string[]>(
    PROMO_SECTION_IDS.map((categoryId) => [categoryId, []]),
  );

  orderedChatIds.forEach((chatId) => {
    const chat = chatsById[chatId];
    if (!chat) return;

    const classification = classifyPromoChat(chat, fullInfoById[chatId], statusById[chatId], serverNow);
    if (classification === 'blocked') return;

    chatIdsByCategory.get(classification)!.push(chatId);
  });

  return categoryOrder.map((categoryId) => {
    const chatIds = chatIdsByCategory.get(categoryId)!;
    const criteria = sortCriteriaByCategoryId[categoryId];

    const sortedChatIds = [...chatIds].sort((a, b) => {
      if (criteria !== 'alphabetical') {
        const valueA = getNumericSortValue(a, criteria, params);
        const valueB = getNumericSortValue(b, criteria, params);
        if (valueA !== valueB) return valueA - valueB;
      }

      return compareTitles(params, a, b);
    });

    return {
      categoryId,
      chatIds: sortedChatIds,
    };
  });
}
