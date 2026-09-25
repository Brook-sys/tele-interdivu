export type PromoCategoryId = 'free' | 'slowmode' | 'stars';

export type PromoSortCriteria = 'alphabetical' | 'starsCost' | 'slowmodeRemaining';

export interface PromoSettings {
  // Folder whose members are visible in the promo panel
  folderId?: number;
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
