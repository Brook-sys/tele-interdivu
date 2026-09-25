import { useEffect, useState } from '../lib/teact/teact';

import { getServerTime } from '../util/serverTime';

const TICK_INTERVAL_MS = 1000;

// Shared 1-second server-time ticker for the promo panel countdowns (single timer for all rows)
export function usePromoServerNow(isActive: boolean) {
  const [now, setNow] = useState(() => getServerTime());

  useEffect(() => {
    if (!isActive) return undefined;

    setNow(getServerTime());
    const interval = window.setInterval(() => {
      setNow(getServerTime());
    }, TICK_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [isActive]);

  return now;
}
