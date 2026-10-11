export type PromoCategoryId = 'free' | 'slowmode' | 'stars';

export type PromoSortCriteria = 'alphabetical' | 'starsCost' | 'slowmodeRemaining';

// Telegram's per-folder chat cap — the manager spills new chats into the next
// selected folder once the earlier ones fill up
export const PROMO_FOLDER_CHAT_LIMIT = 100;

export interface PromoSettings {
  // Folders whose members feed the promo panel, automation targets and link
  // extraction; the first one with room receives chats added by the manager
  folderIds?: number[];
  // Order of the fixed sections in the panel
  categoryOrder: PromoCategoryId[];
  sortCriteriaByCategoryId: Record<PromoCategoryId, PromoSortCriteria>;
}

export interface PromoChatStatus {
  // Server time (seconds) of the last own outgoing message
  lastOwnMessageAt?: number;
  // Server time (seconds) of the last successful full info fetch
  fullInfoFetchedAt?: number;
}

export interface PromoUserState {
  settings: PromoSettings;
  statusById: Record<string, PromoChatStatus>;
}

export interface PromoState {
  byUserId: Record<string, PromoUserState>;
}

export const DEFAULT_PROMO_SETTINGS: PromoSettings = {
  categoryOrder: ['free', 'slowmode', 'stars'],
  sortCriteriaByCategoryId: {
    free: 'alphabetical',
    slowmode: 'slowmodeRemaining',
    stars: 'starsCost',
  },
};

export const EMPTY_PROMO_USER_STATE: PromoUserState = {
  settings: DEFAULT_PROMO_SETTINGS,
  statusById: {},
};
