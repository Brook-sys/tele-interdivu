import type {
  PromoCategoryId, PromoSettings, PromoSortCriteria,
} from '../../global/types/promo';
import { DEFAULT_PROMO_SETTINGS } from '../../global/types/promo';

const VALID_CATEGORY_IDS: PromoCategoryId[] = ['free', 'slowmode', 'stars'];
const VALID_SORT_CRITERIA: PromoSortCriteria[] = ['alphabetical', 'starsCost', 'slowmodeRemaining'];

export function serializePromoSettings(settings: PromoSettings): string {
  return JSON.stringify({ promoSettings: settings }, undefined, 2);
}

function getIsCategoryOrderValid(value: unknown): value is PromoCategoryId[] {
  return Array.isArray(value)
    && value.length === VALID_CATEGORY_IDS.length
    && VALID_CATEGORY_IDS.every((id) => value.includes(id));
}

export function parsePromoSettings(value: string): PromoSettings | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }

  const raw = (parsed as { promoSettings?: unknown }).promoSettings;
  if (!raw || typeof raw !== 'object') return undefined;

  const {
    folderId, folderIds, categoryOrder, sortCriteriaByCategoryId,
  } = raw as {
    folderId?: unknown;
    folderIds?: unknown;
    categoryOrder?: unknown;
    sortCriteriaByCategoryId?: unknown;
  };

  if (!getIsCategoryOrderValid(categoryOrder)) return undefined;

  const nextSortCriteria = { ...DEFAULT_PROMO_SETTINGS.sortCriteriaByCategoryId };
  if (sortCriteriaByCategoryId && typeof sortCriteriaByCategoryId === 'object') {
    const criteriaById = sortCriteriaByCategoryId as Record<string, unknown>;
    VALID_CATEGORY_IDS.forEach((categoryId) => {
      const criteria = criteriaById[categoryId];
      if (typeof criteria === 'string' && VALID_SORT_CRITERIA.includes(criteria as PromoSortCriteria)) {
        nextSortCriteria[categoryId] = criteria as PromoSortCriteria;
      }
    });
  }

  return {
    // Legacy exports carry a single `folderId`; current ones carry the full list
    folderIds: parseFolderIds(folderIds, folderId),
    categoryOrder,
    sortCriteriaByCategoryId: nextSortCriteria,
  };
}

function parseFolderIds(folderIds: unknown, legacyFolderId: unknown): number[] | undefined {
  if (Array.isArray(folderIds)) {
    const parsed = folderIds.filter((id): id is number => typeof id === 'number');
    return parsed.length ? parsed : undefined;
  }

  return typeof legacyFolderId === 'number' ? [legacyFolderId] : undefined;
}
