export function parseSpintax(text: string): string {
  if (!text) return '';

  let current = text;
  const regex = /\{([^{}]+)\}/;

  // Resolves inner-most braces iteratively until none remain
  while (regex.test(current)) {
    current = current.replace(regex, (_, choicesString: string) => {
      const choices = choicesString.split('|');
      const picked = choices[Math.floor(Math.random() * choices.length)];
      return picked !== undefined ? picked : '';
    });
  }

  return current;
}

export function compileSpunMessage(
  template: string,
  links: string[],
): { messageText: string; linkUsed: string } {
  let text = template;
  let linkUsed = '';

  if (links && links.length > 0) {
    linkUsed = links[Math.floor(Math.random() * links.length)] || '';
    if (/\{LINK\}|\{link\}|\{URL\}|\{url\}/i.test(text)) {
      text = text.replace(/\{LINK\}|\{link\}|\{URL\}|\{url\}/gi, linkUsed);
    } else {
      text = `${text}\n${linkUsed}`.trim();
    }
  }

  const spun = parseSpintax(text);

  return {
    messageText: spun,
    linkUsed,
  };
}

export function validateSpintaxSyntax(text: string): { isValid: boolean; error?: string } {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth < 0) {
        return { isValid: false, error: `Closing brace '}' without opening at index ${i}` };
      }
    }
  }

  if (depth !== 0) {
    return { isValid: false, error: `${depth} unclosed brace(s) '{'` };
  }

  return { isValid: true };
}

// Picks the template for a send: first enabled when rotation is off,
// weighted-random among enabled ones when rotation is on (A/B testing)
export function pickTemplate<T extends { weight: number; isEnabled: boolean }>(
  templates: T[],
  isRotationEnabled: boolean,
): T | undefined {
  const enabled = templates.filter((t) => t.isEnabled);
  if (!enabled.length) return undefined;
  if (!isRotationEnabled || enabled.length === 1) return enabled[0];

  const weights = enabled.map((t) => Math.max(1, Number(t.weight) || 1));
  const total = weights.reduce((sum, w) => sum + w, 0);

  let roll = Math.random() * total;
  for (let i = 0; i < enabled.length; i++) {
    roll -= weights[i];
    if (roll < 0) return enabled[i];
  }

  return enabled[enabled.length - 1];
}

export interface DestinationLike {
  id: number;
  weight: number;
  isEnabled: boolean;
}

export interface LinkLike {
  url: string;
  isEnabled: boolean;
  destinationId?: number;
}

// Resolves the link pool for a single send: a weighted-random pick among
// enabled destinations that have at least one enabled link, returning that
// destination's links. Loose (unassigned) links are only used when no
// destination qualifies, so a focused destination never leaks other links
export function pickPromotionPool<T extends DestinationLike, L extends LinkLike>(
  destinations: T[],
  links: L[],
): { urls: string[]; destinationId?: number } {
  const urlsByDestinationId = new Map<number, string[]>();
  const looseUrls: string[] = [];

  for (const link of links) {
    if (!link.isEnabled) continue;
    if (link.destinationId === undefined) {
      looseUrls.push(link.url);
      continue;
    }
    const bucket = urlsByDestinationId.get(link.destinationId);
    if (bucket) bucket.push(link.url);
    else urlsByDestinationId.set(link.destinationId, [link.url]);
  }

  const candidates = destinations.filter(
    (destination) => destination.isEnabled
      && (urlsByDestinationId.get(destination.id)?.length ?? 0) > 0,
  );
  if (!candidates.length) return { urls: looseUrls };

  if (candidates.length === 1) {
    return { urls: urlsByDestinationId.get(candidates[0].id)!, destinationId: candidates[0].id };
  }

  const weights = candidates.map((destination) => Math.max(1, Number(destination.weight) || 1));
  const total = weights.reduce((sum, w) => sum + w, 0);

  let roll = Math.random() * total;
  let picked = candidates[candidates.length - 1];
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll < 0) {
      picked = candidates[i];
      break;
    }
  }

  return { urls: urlsByDestinationId.get(picked.id)!, destinationId: picked.id };
}

// Upper bound of unique messages a template × links can produce:
// choices inside a group sum up (each choice may expand further),
// sibling groups multiply
export function countMessageVariations(text: string, links: string[]): number {
  let variations = countVariations(text);
  if (links.length > 0) variations *= links.length;
  return variations;
}

function countVariations(text: string): number {
  let total = 1;
  let index = 0;

  while (index < text.length) {
    const open = text.indexOf('{', index);
    if (open === -1) break;

    let depth = 1;
    let close = open + 1;
    while (close < text.length && depth > 0) {
      if (text[close] === '{') depth++;
      else if (text[close] === '}') depth--;
      close++;
    }

    const inner = text.slice(open + 1, close - 1);
    const choices = inner.split('|');
    const groupCount = choices.reduce((sum, choice) => sum + countVariations(choice), 0);
    total *= Math.max(1, groupCount);
    index = close;
  }

  return total;
}
