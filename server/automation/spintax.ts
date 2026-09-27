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
