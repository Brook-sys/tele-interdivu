// Guards account-facing link resolution against Telegram flood limits.
// `messages.CheckChatInvite` and `contacts.ResolveUsername` are strictly
// rate-limited: a burst of resolutions triggers FLOOD_WAIT, and retrying
// inside the wait window can extend it, so every resolve goes through this
// gate — cache first, then flood check, then human-like pacing before the
// actual API call.

const DEFAULT_PACING_MS = 4000;
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

const FLOOD_WAIT_PATTERN = /^FLOOD_WAIT_(\d+)$/;
const FLOOD_WAIT_SEARCH_PATTERN = /FLOOD_WAIT_(\d+)/;

// Thrown while a FLOOD_WAIT window is still active so callers can back off
// without touching the API (retrying inside the window extends it)
export class FloodWaitActiveError extends Error {
  public readonly remainingSeconds: number;

  constructor(remainingSeconds: number) {
    super(`Telegram flood limit active — try again in ${Math.max(1, Math.ceil(remainingSeconds / 60))} min`);
    this.name = 'FloodWaitActiveError';
    this.remainingSeconds = remainingSeconds;
  }
}

// Extracts the wait in seconds from a GramJS `RPCError`-shaped object
export function parseFloodWaitSeconds(err: unknown): number | undefined {
  const asErr = err as { errorMessage?: string; message?: string } | undefined;
  const match = String(asErr?.errorMessage || '').match(FLOOD_WAIT_PATTERN)
    ?? String(asErr?.message || '').match(FLOOD_WAIT_SEARCH_PATTERN);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

export class ResolveGuard {
  private floodUntil = 0;
  private lastApiCallAt = 0;
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();

  constructor(
    private readonly pacingMs = DEFAULT_PACING_MS,
    private readonly cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  ) {}

  getCached<T>(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  store<T>(key: string, value: T) {
    // Re-insert so eviction below always drops the oldest entry
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }

  // Records a FLOOD_WAIT response; returns the wait in seconds when the
  // error was a flood, `undefined` otherwise
  registerFlood(err: unknown): number | undefined {
    const seconds = parseFloodWaitSeconds(err);
    if (seconds === undefined) return undefined;
    this.floodUntil = Math.max(this.floodUntil, Date.now() + seconds * 1000);
    return seconds;
  }

  getRemainingFloodSeconds(): number {
    return Math.max(0, Math.ceil((this.floodUntil - Date.now()) / 1000));
  }

  assertNotFlooded(): void {
    const remainingSeconds = this.getRemainingFloodSeconds();
    if (remainingSeconds > 0) throw new FloodWaitActiveError(remainingSeconds);
  }

  // Human-like spacing between consecutive resolve API calls
  async awaitPace(): Promise<void> {
    const sinceLastCall = Date.now() - this.lastApiCallAt;
    if (sinceLastCall < this.pacingMs) {
      await new Promise((resolve) => setTimeout(resolve, this.pacingMs - sinceLastCall));
    }
    this.lastApiCallAt = Date.now();
  }
}
