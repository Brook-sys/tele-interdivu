// Client-side mirror of server/automation/spintax.ts — powers instant
// preview, validation and variation counting in the campaign editor
// without a round-trip per keystroke. The server remains authoritative
// at send time.

export function parseSpintax(text: string): string {
  if (!text) return '';

  let current = text;
  const regex = /\{([^{}]+)\}/;

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

  return { messageText: parseSpintax(text), linkUsed };
}

export function validateSpintaxSyntax(text: string): { isValid: boolean; error?: string } {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth < 0) {
        return { isValid: false, error: `'} sem '{' correspondente na posição ${i}` };
      }
    }
  }

  if (depth !== 0) {
    return { isValid: false, error: `${depth} chave(s) '{' sem fechar` };
  }

  return { isValid: true };
}

// Picks the template for a preview: first enabled when rotation is off,
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
