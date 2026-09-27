import { describe, expect, it } from 'vitest';

import { compileSpunMessage, parseSpintax, validateSpintaxSyntax } from './spintax';

describe('spintax parser', () => {
  it('parses simple flat spintax', () => {
    const template = '{Olá|Oi|E aí} amigo!';
    const variations = new Set<string>();
    for (let i = 0; i < 50; i++) {
      variations.add(parseSpintax(template));
    }

    expect(variations.size).toBe(3);
    expect(variations.has('Olá amigo!')).toBe(true);
    expect(variations.has('Oi amigo!')).toBe(true);
    expect(variations.has('E aí amigo!')).toBe(true);
  });

  it('parses nested spintax recursively', () => {
    const template = '{Bom {dia|começo de semana}|Boa {tarde|noite}}';
    const variations = new Set<string>();
    for (let i = 0; i < 100; i++) {
      variations.add(parseSpintax(template));
    }

    expect(variations.has('Bom dia')).toBe(true);
    expect(variations.has('Bom começo de semana')).toBe(true);
    expect(variations.has('Boa tarde')).toBe(true);
    expect(variations.has('Boa noite')).toBe(true);
  });

  it('compiles message with link placeholder substitution', () => {
    const links = ['https://t.me/link1', 'https://t.me/link2'];
    const template = 'Confira: {LINK}';

    const result = compileSpunMessage(template, links);
    expect(result.messageText.startsWith('Confira: https://t.me/link')).toBe(true);
    expect(links.includes(result.linkUsed)).toBe(true);
  });

  it('appends link automatically if placeholder is missing', () => {
    const links = ['https://t.me/promo'];
    const template = 'Promoção imperdível!';

    const result = compileSpunMessage(template, links);
    expect(result.messageText).toBe('Promoção imperdível!\nhttps://t.me/promo');
    expect(result.linkUsed).toBe('https://t.me/promo');
  });

  it('validates spintax syntax balance accurately', () => {
    expect(validateSpintaxSyntax('{Oi|Olá} mundo').isValid).toBe(true);
    expect(validateSpintaxSyntax('{Oi {amigo|parceiro}|Olá}').isValid).toBe(true);
    expect(validateSpintaxSyntax('{Oi|Olá').isValid).toBe(false);
    expect(validateSpintaxSyntax('Oi|Olá}').isValid).toBe(false);
  });
});
