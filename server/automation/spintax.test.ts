import { describe, expect, it } from 'vitest';

import {
  compileSpunMessage,
  countMessageVariations,
  parseSpintax,
  pickPromotionPool,
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

describe('pickPromotionPool', () => {
  it('returns the single enabled destination deterministically', () => {
    const destinations = [{ id: 1, name: 'X', weight: 1, isEnabled: true }];
    const links = [
      { url: 'https://t.me/a', isEnabled: true, destinationId: 1 },
      { url: 'https://t.me/b', isEnabled: true, destinationId: 1 },
      { url: 'https://t.me/loose', isEnabled: true },
    ];

    const pool = pickPromotionPool(destinations, links);
    expect(pool.destinationId).toBe(1);
    expect(pool.urls).toEqual(['https://t.me/a', 'https://t.me/b']);
  });

  it('falls back to loose links when no destination qualifies', () => {
    const destinations = [
      { id: 1, name: 'off', weight: 1, isEnabled: false },
      { id: 2, name: 'no links', weight: 1, isEnabled: true },
      { id: 3, name: 'disabled links', weight: 1, isEnabled: true },
    ];
    const links = [
      { url: 'https://t.me/loose1', isEnabled: true },
      { url: 'https://t.me/loose2', isEnabled: true },
      { url: 'https://t.me/c3', isEnabled: false, destinationId: 3 },
    ];

    const pool = pickPromotionPool(destinations, links);
    expect(pool.destinationId).toBeUndefined();
    expect(pool.urls).toEqual(['https://t.me/loose1', 'https://t.me/loose2']);
  });

  it('never returns an empty pool while enabled links exist', () => {
    const destinations = [{ id: 1, name: 'X', weight: 1, isEnabled: true }];
    const links = [{ url: 'https://t.me/a', isEnabled: true, destinationId: 1 }];
    for (let i = 0; i < 20; i++) {
      expect(pickPromotionPool(destinations, links).urls).toHaveLength(1);
    }
  });

  it('picks weighted-random among enabled destinations with enabled links', () => {
    const destinations = [
      { id: 1, name: 'a', weight: 1, isEnabled: true },
      { id: 2, name: 'b', weight: 3, isEnabled: true },
      { id: 3, name: 'off', weight: 1, isEnabled: false },
    ];
    const links = [
      { url: 'https://t.me/a', isEnabled: true, destinationId: 1 },
      { url: 'https://t.me/b', isEnabled: true, destinationId: 2 },
      { url: 'https://t.me/c', isEnabled: true, destinationId: 3 },
    ];

    const counts: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (let i = 0; i < 4000; i++) {
      counts[pickPromotionPool(destinations, links).destinationId!]++;
    }

    // Roughly 25% / 75% split with a tolerance band for randomness;
    // disabled destinations are never picked
    expect(counts[1]).toBeGreaterThan(700);
    expect(counts[1]).toBeLessThan(1300);
    expect(counts[2]).toBeGreaterThan(2700);
    expect(counts[3]).toBe(0);
  });

  it('treats weight below 1 as 1 so a destination is never impossible to pick', () => {
    const destinations = [
      { id: 1, name: 'a', weight: 0, isEnabled: true },
      { id: 2, name: 'b', weight: 5, isEnabled: true },
    ];
    const links = [
      { url: 'https://t.me/a', isEnabled: true, destinationId: 1 },
      { url: 'https://t.me/b', isEnabled: true, destinationId: 2 },
    ];

    const picked = new Set<number>();
    for (let i = 0; i < 200; i++) {
      picked.add(pickPromotionPool(destinations, links).destinationId!);
    }
    expect(picked.has(1)).toBe(true);
  });
});
