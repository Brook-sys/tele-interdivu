import type { GlobalState } from '../types';
import type { PromoChatStatus, PromoSettings, PromoUserState } from '../types/promo';
import { DEFAULT_PROMO_SETTINGS, EMPTY_PROMO_USER_STATE } from '../types/promo';

export function selectPromoUserState(global: GlobalState): PromoUserState {
  const userId = global.currentUserId;
  return (userId && global.promo.byUserId[userId]) || EMPTY_PROMO_USER_STATE;
}

export function selectPromoSettings(global: GlobalState): PromoSettings {
  const userId = global.currentUserId;
  return global.promo.byUserId[userId ?? '']?.settings ?? DEFAULT_PROMO_SETTINGS;
}

export function selectPromoChatStatus(global: GlobalState, chatId: string): PromoChatStatus | undefined {
  const userId = global.currentUserId;
  return global.promo.byUserId[userId ?? '']?.statusById[chatId];
}
