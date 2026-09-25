import { describe, expect, it } from 'vitest';

import type { PromoSettings } from '../../global/types/promo';
import { DEFAULT_PROMO_SETTINGS } from '../../global/types/promo';

import { parsePromoSettings, serializePromoSettings } from './settingsSerialization';

describe('settingsSerialization', () => {
  it('round-trips valid settings', () => {
    const settings: PromoSettings = {
      folderId: 3,
      ...DEFAULT_PROMO_SETTINGS,
      categoryOrder: ['stars', 'free', 'slowmode'],
    };

    expect(parsePromoSettings(serializePromoSettings(settings))).toEqual(settings);
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
    expect(result!.folderId).toBeUndefined();
  });
});
