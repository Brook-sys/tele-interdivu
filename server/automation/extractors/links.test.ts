import { describe, expect, it } from 'vitest';

import { classifyLink, extractLinks, normalizeLink } from './links';

describe('normalizeLink', () => {
  it('normalizes scheme, www and trailing slash on external links', () => {
    expect(normalizeLink(' HTTPS://WWW.Example.COM/path/ ')?.value).toBe('example.com/path');
    expect(normalizeLink('https://example.com/a/?x=1')?.value).toBe('example.com/a?x=1');
  });

  it('normalizes telegram hosts to lowercase domain', () => {
    expect(normalizeLink('https://telegram.me/SomeUser')?.value).toBe('telegram.me/someuser');
    expect(normalizeLink('t.me/SomeUser')?.value).toBe('t.me/someuser');
  });

  it('keeps invite hash case intact', () => {
    expect(normalizeLink('https://t.me/+AbCDef123')?.value).toBe('t.me/+AbCDef123');
    expect(normalizeLink('t.me/joinchat/AbCDef')?.value).toBe('t.me/joinchat/AbCDef');
  });

  it('strips trailing punctuation captured by raw regex', () => {
    expect(normalizeLink('https://example.com/page.')?.value).toBe('example.com/page');
  });

  it('rejects garbage', () => {
    expect(normalizeLink('not a link')).toBeUndefined();
    expect(normalizeLink('')).toBeUndefined();
  });
});

describe('classifyLink', () => {
  it('classifies invite links', () => {
    expect(classifyLink('t.me', 't.me/+abc123')).toBe('invite_link');
    expect(classifyLink('telegram.me', 'telegram.me/joinchat/xyz')).toBe('invite_link');
  });

  it('classifies telegram non-invite links', () => {
    expect(classifyLink('t.me', 't.me/somechannel')).toBe('tg_link');
    expect(classifyLink('t.me', 't.me/somebot?start=1')).toBe('tg_link');
  });

  it('classifies external links', () => {
    expect(classifyLink('example.com', 'example.com/page')).toBe('external_link');
  });
});

describe('extractLinks', () => {
  it('extracts plain text links', () => {
    const links = extractLinks({ text: 'Entre aqui https://t.me/+HASH123 e veja https://site.com/oferta' });
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ kind: 'invite_link', value: 't.me/+HASH123' });
    expect(links[1]).toMatchObject({ kind: 'external_link', value: 'site.com/oferta' });
  });

  it('extracts hidden links from TextUrl entities', () => {
    const links = extractLinks({
      text: 'CLIQUE AQUI AGORA',
      entities: [{
        className: 'MessageEntityTextUrl',
        url: 'https://t.me/+HiddenInvite',
        offset: 0,
        length: 6,
      }],
    });
    expect(links).toHaveLength(1);
    expect(links[0].kind).toBe('invite_link');
    expect(links[0].value).toBe('t.me/+HiddenInvite');
  });

  it('extracts visible links from Url entities', () => {
    const links = extractLinks({
      text: 'acesse t.me/mychannel agora',
      entities: [{ className: 'MessageEntityUrl', offset: 7, length: 15 }],
    });
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ kind: 'tg_link', value: 't.me/mychannel' });
  });

  it('dedups identical links inside the same message', () => {
    const links = extractLinks({
      text: 'https://t.me/+ABC https://t.me/+ABC t.me/+ABC',
    });
    expect(links).toHaveLength(1);
  });

  it('returns empty for messages without links', () => {
    expect(extractLinks({ text: 'só texto sem links' })).toHaveLength(0);
    expect(extractLinks({})).toHaveLength(0);
  });

  it('ignores non-url entities', () => {
    const links = extractLinks({
      text: 'texto em negrito',
      entities: [{ className: 'MessageEntityBold', offset: 0, length: 5 }],
    });
    expect(links).toHaveLength(0);
  });
});
