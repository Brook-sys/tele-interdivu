import type { ActionReturnType } from '../../types';

import { addActionHandler } from '../../index';
import { updatePromoSettings } from '../../reducers/promo';

addActionHandler('setPromoSettings', (global, actions, payload): ActionReturnType => {
  const { patch } = payload;

  return updatePromoSettings(global, patch);
});
