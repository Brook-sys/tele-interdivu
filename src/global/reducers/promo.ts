import type { ApiMessage } from '../../api/types';
import type { GlobalState } from '../types';
import type { PromoSettings, PromoUserState } from '../types/promo';
import { EMPTY_PROMO_USER_STATE } from '../types/promo';

function updatePromoUserState<T extends GlobalState>(
  global: T,
  updater: (userState: PromoUserState) => PromoUserState,
): T {
  const userId = global.currentUserId;
  if (!userId) return global;

  const currentUserState = global.promo.byUserId[userId] ?? EMPTY_PROMO_USER_STATE;

  return {
    ...global,
    promo: {
      ...global.promo,
      byUserId: {
        ...global.promo.byUserId,
        [userId]: updater(currentUserState),
      },
    },
  };
}

export function recordPromoOutgoing<T extends GlobalState>(
  global: T,
  chatId: string,
  message: ApiMessage,
): T {
  const userId = global.currentUserId;
  if (!userId || !message.isOutgoing || message.content.action) return global;

  const currentLastOwnMessageAt = global.promo.byUserId[userId]?.statusById[chatId]?.lastOwnMessageAt;
  if (currentLastOwnMessageAt && currentLastOwnMessageAt >= message.date) return global;

  return updatePromoUserState(global, (userState) => ({
    ...userState,
    statusById: {
      ...userState.statusById,
      [chatId]: {
        ...userState.statusById[chatId],
        lastOwnMessageAt: message.date,
      },
    },
  }));
}

export function recordPromoFullInfoFetch<T extends GlobalState>(
  global: T,
  chatId: string,
  serverNow: number,
): T {
  return updatePromoUserState(global, (userState) => ({
    ...userState,
    statusById: {
      ...userState.statusById,
      [chatId]: {
        ...userState.statusById[chatId],
        fullInfoFetchedAt: serverNow,
      },
    },
  }));
}

export function updatePromoSettings<T extends GlobalState>(
  global: T,
  patch: Partial<PromoSettings>,
): T {
  return updatePromoUserState(global, (userState) => ({
    ...userState,
    settings: {
      ...userState.settings,
      ...patch,
    },
  }));
}

export function clearPromoChatStatuses<T extends GlobalState>(global: T): T {
  return updatePromoUserState(global, (userState) => ({
    ...userState,
    statusById: {},
  }));
}
