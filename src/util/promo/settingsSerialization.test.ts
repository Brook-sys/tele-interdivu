import { describe, expect, it } from 'vitest';

import type { PromoSettings } from '../../global/types/promo';
import { DEFAULT_PROMO_SETTINGS } from '../../global/types/promo';

import { parsePromoSettings, serializePromoSettings } from './settingsSerialization';

describe('settingsSerialization', () => {
  it('round-trips valid settings', () => {
    const settings: PromoSettings = {
      folderIds: [3, 7],
      ...DEFAULT_PROMO_SETTINGS,
      categoryOrder: ['stars', 'free', 'slowmode'],
    };

    expect(parsePromoSettings(serializePromoSettings(settings))).toEqual(settings);
  });

  it('imports a legacy single-folder export as a one-element list', () => {
    const result = parsePromoSettings(JSON.stringify({
      promoSettings: {
        folderId: 3,
        categoryOrder: ['free', 'slowmode', 'stars'],
      },
    }));

    expect(result).toBeDefined();
    expect(result!.folderIds).toEqual([3]);
  });

  it('rejects invalid JSON', () => {
    expect(parsePromoSettings('not json')).toBeUndefined();
  });

  it('rejects payloads without a promoSettings object', () => {
    expect(parsePromoSettings('{"other":1}')).toBeUndefined();
  });

  it('rejects an incomplete category order', () => {
    expect(parsePromoSettings('{"promoSettings":{"categoryOrder":["free","stars"]}}')).toBeUndefined();
  });

  it('falls back to defaults for unknown sort criteria', () => {
    const result = parsePromoSettings(JSON.stringify({
      promoSettings: {
        categoryOrder: ['free', 'slowmode', 'stars'],
        sortCriteriaByCategoryId: {
          free: 'nonsense',
          stars: 'starsCost',
        },
      },
    }));

    expect(result).toBeDefined();
    expect(result!.sortCriteriaByCategoryId.free).toBe('alphabetical');
    expect(result!.sortCriteriaByCategoryId.stars).toBe('starsCost');
  });

  it('drops an invalid folder id', () => {
    const payload = '{"promoSettings":{"folderId":"abc","categoryOrder":["free","slowmode","stars"]}}';
    const result = parsePromoSettings(payload);

    expect(result).toBeDefined();
    expect(result!.folderIds).toBeUndefined();
  });

  it('drops folder ids that are not numbers', () => {
    const result = parsePromoSettings(JSON.stringify({
      promoSettings: {
        folderIds: [3, 'abc', 7],
        categoryOrder: ['free', 'slowmode', 'stars'],
      },
    }));

    expect(result).toBeDefined();
    expect(result!.folderIds).toEqual([3, 7]);
  });
});
