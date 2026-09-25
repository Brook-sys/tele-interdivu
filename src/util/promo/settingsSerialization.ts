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
    folderId, categoryOrder, sortCriteriaByCategoryId,
  } = raw as {
    folderId?: unknown;
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
    folderId: typeof folderId === 'number' ? folderId : undefined,
    categoryOrder,
    sortCriteriaByCategoryId: nextSortCriteria,
  };
}
