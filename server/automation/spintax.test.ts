import { describe, expect, it } from 'vitest';

import {
  compileSpunMessage,
  countMessageVariations,
  parseSpintax,
  pickTemplate,
  validateSpintaxSyntax,
} from './spintax';

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

describe('pickTemplate', () => {
  it('returns the first enabled template when rotation is off', () => {
    const templates = [
      { weight: 1, isEnabled: false, content: 'a' },
      { weight: 1, isEnabled: true, content: 'b' },
      { weight: 1, isEnabled: true, content: 'c' },
    ];
    expect(pickTemplate(templates, false)?.content).toBe('b');
  });

  it('returns undefined when no template is enabled', () => {
    expect(pickTemplate([{ weight: 1, isEnabled: false, content: 'a' }], false)).toBeUndefined();
  });

  it('picks weighted-random among enabled templates when rotation is on', () => {
    const templates = [
      { weight: 1, isEnabled: true, content: 'a' },
      { weight: 3, isEnabled: true, content: 'b' },
      { weight: 1, isEnabled: false, content: 'disabled' },
    ];

    const counts = { a: 0, b: 0 };
    for (let i = 0; i < 4000; i++) {
      const picked = pickTemplate(templates, true);
      counts[picked!.content as 'a' | 'b']++;
    }

    // Roughly 25% / 75% split with a tolerance band for randomness
    expect(counts.a).toBeGreaterThan(700);
    expect(counts.a).toBeLessThan(1300);
    expect(counts.b).toBeGreaterThan(2700);
  });

  it('treats weight below 1 as 1 so a template is never impossible to pick', () => {
    const templates = [
      { weight: 0, isEnabled: true, content: 'a' },
      { weight: 5, isEnabled: true, content: 'b' },
    ];
    const picks = new Set<string>();
    for (let i = 0; i < 200; i++) {
      picks.add(pickTemplate(templates, true)!.content);
    }
    expect(picks.has('a')).toBe(true);
  });
});

describe('countMessageVariations', () => {
  it('multiplies flat groups and links', () => {
    expect(countMessageVariations('{a|b} {c|d|e}', ['l1', 'l2'])).toBe(12);
  });

  it('sums nested choices instead of multiplying them', () => {
    // {a|{b|c}} produces a, b or c = 3 distinct outcomes
    expect(countMessageVariations('{a|{b|c}}', [])).toBe(3);
  });

  it('counts empty choices as valid variations', () => {
    expect(countMessageVariations('{a|}', [])).toBe(2);
  });

  it('returns 1 for a template without groups or links', () => {
    expect(countMessageVariations('mensagem fixa', [])).toBe(1);
  });
});
