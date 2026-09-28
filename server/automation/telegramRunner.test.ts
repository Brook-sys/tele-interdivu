import { describe, expect, it } from 'vitest';

import { extractMessagesFromGramJsUpdate } from './telegramRunner';

describe('extractMessagesFromGramJsUpdate', () => {
  it('handles null/undefined gracefully', () => {
    expect(extractMessagesFromGramJsUpdate(undefined)).toEqual([]);
  });

  it('unwraps updates container (GramJs.Updates / UpdatesCombined)', () => {
    const update = {
      updates: [
        {
          message: {
            id: 1,
            peerId: { channelId: 123456n },
            message: 'Hello 1',
            out: false,
          },
        },
        {
          message: {
            id: 2,
            peerId: { channelId: 123456n },
            message: 'Hello 2',
            out: true,
          },
        },
      ],
    };

    const messages = extractMessagesFromGramJsUpdate(update);
    expect(messages.length).toBe(2);
    expect(messages[0].id).toBe(1);
    expect(messages[1].id).toBe(2);
    expect(messages[1].out).toBe(true);
  });

  it('unwraps UpdateShort', () => {
    const update = {
      update: {
        message: {
          id: 55,
          peerId: { chatId: 987n },
          message: 'Short update message',
          out: false,
        },
      },
    };

    const messages = extractMessagesFromGramJsUpdate(update);
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(55);
  });

  it('unwraps direct UpdateNewChannelMessage', () => {
    const update = {
      message: {
        id: 100,
        peerId: { channelId: 555n },
        message: 'Direct channel message',
        out: false,
      },
    };

    const messages = extractMessagesFromGramJsUpdate(update);
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(100);
  });

  it('unwraps UpdateShortChatMessage', () => {
    const update = {
      chatId: 444n,
      message: 'Short chat text',
      out: false,
      date: 1790000000,
    };

    const messages = extractMessagesFromGramJsUpdate(update);
    expect(messages.length).toBe(1);
    expect(messages[0].peerId.chatId).toBe(444n);
  });
});
