// Passive link extraction from incoming Telegram messages.
// Pure functions over the raw MTProto message payload — no network access.

export type ExtractedLinkKind = 'invite_link' | 'tg_link' | 'external_link';

export interface RawExtractMessage {
  messageId?: number;
  text?: string;
  entities?: {
    className?: string;
    url?: string;
    offset?: number;
    length?: number;
  }[];
}

export interface ExtractedLink {
  kind: ExtractedLinkKind;
  value: string;
  domain?: string;
  preview?: string;
}

export const EXTRACTOR_KIND = 'links';

const URL_REGEX = /(?:https?:\/\/|t\.me\/|telegram\.me\/|telegram\.dog\/)[^\s<>"'\])}\]]+/gi;
const MAX_PREVIEW_LENGTH = 80;

const TG_HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);

export function normalizeLink(rawUrl: string): { value: string; domain: string } | undefined {
  let url = rawUrl.trim();
  if (!url) return undefined;

  // Drop trailing punctuation commonly attached by chat formatting
  url = url.replace(/[.,;!?]+$/, '');

  const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return undefined;
  }

  const domain = parsed.hostname.toLowerCase().replace(/^www\./, '');
  let path = parsed.pathname.replace(/\/+$/, '');

  if (TG_HOSTS.has(domain)) {
    // t.me links are case-insensitive on everything (username or invite hash
    // is matched exactly though — hashes are case-sensitive, keep as-is but
    // lowercase only the username-style single-segment paths)
    const segments = path.split('/').filter(Boolean);
    if (segments.length === 1 && !segments[0].startsWith('+') && segments[0] !== 'joinchat') {
      path = `/${segments[0].toLowerCase()}`;
    }
    return { value: `${domain}${path}`, domain };
  }

  // External links keep the full path + query for fidelity
  const queryString = parsed.search || '';
  return { value: `${domain}${path}${queryString}`, domain };
}

export function classifyLink(domain: string, value: string): ExtractedLinkKind {
  if (!TG_HOSTS.has(domain)) return 'external_link';

  const path = value.slice(domain.length);
  if (path.startsWith('/+') || path.startsWith('/joinchat/')) return 'invite_link';

  return 'tg_link';
}

export function extractLinks(message: RawExtractMessage): ExtractedLink[] {
  const text = message.text || '';
  const found = new Map<string, ExtractedLink>();

  // 1. Entity-carried URLs first (hidden links behind text)
  for (const entity of message.entities || []) {
    if (entity.className !== 'MessageEntityUrl' && entity.className !== 'MessageEntityTextUrl') continue;

    const raw = entity.className === 'MessageEntityTextUrl'
      ? entity.url
      : text.slice(entity.offset || 0, (entity.offset || 0) + (entity.length || 0));

    if (!raw) continue;

    const normalized = normalizeLink(raw);
    if (!normalized) continue;

    const kind = classifyLink(normalized.domain, normalized.value);
    if (!found.has(normalized.value)) {
      found.set(normalized.value, {
        kind,
        value: normalized.value,
        domain: normalized.domain,
        preview: kind === 'invite_link' || entity.className === 'MessageEntityTextUrl'
          ? text.slice(0, MAX_PREVIEW_LENGTH) || undefined
          : undefined,
      });
    }
  }

  // 2. Plain regex over the raw text catches links without entities
  if (text) {
    const matches = text.match(URL_REGEX) || [];
    for (const match of matches) {
      const normalized = normalizeLink(match);
      if (!normalized) continue;

      if (!found.has(normalized.value)) {
        found.set(normalized.value, {
          kind: classifyLink(normalized.domain, normalized.value),
          value: normalized.value,
          domain: normalized.domain,
        });
      }
    }
  }

  return [...found.values()];
}
