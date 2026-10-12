import { describe, expect, it } from 'vitest';

import {
  extractMessagesFromGramJsUpdate,
  getChannelParticipantWriteCheck,
  getIsPermanentParticipantError,
} from './telegramRunner';

describe('getChannelParticipantWriteCheck', () => {
  it('allows regular members, admins and creators', () => {
    expect(getChannelParticipantWriteCheck({ className: 'ChannelParticipantSelf' }).canWrite).toBe(true);
    expect(getChannelParticipantWriteCheck({ className: 'ChannelParticipant' }).canWrite).toBe(true);
    expect(getChannelParticipantWriteCheck({ className: 'ChannelParticipantAdmin' }).canWrite).toBe(true);
    expect(getChannelParticipantWriteCheck({ className: 'ChannelParticipantCreator' }).canWrite).toBe(true);
  });

  it('blocks removed participants without a probe gate', () => {
    expect(getChannelParticipantWriteCheck({
      className: 'ChannelParticipantBanned',
      left: true,
      bannedRights: { viewMessages: true },
    })).toEqual({ canWrite: false });
  });

  it('blocks write-restricting granular bans and reports their end date', () => {
    expect(getChannelParticipantWriteCheck({
      className: 'ChannelParticipantBanned',
      bannedRights: { sendMessages: true, untilDate: 1765540800 },
    })).toEqual({ canWrite: false, bannedUntil: 1765540800 });
    expect(getChannelParticipantWriteCheck({
      className: 'ChannelParticipantBanned',
      bannedRights: { sendPlain: true },
    }).canWrite).toBe(false);
    expect(getChannelParticipantWriteCheck({
      className: 'ChannelParticipantBanned',
      bannedRights: { embedLinks: true },
    }).canWrite).toBe(false);
    expect(getChannelParticipantWriteCheck({
      className: 'ChannelParticipantBanned',
      bannedRights: { viewMessages: true, untilDate: 0 },
    })).toEqual({ canWrite: false, bannedUntil: 0 });
  });

  it('allows participants banned from other actions only', () => {
    expect(getChannelParticipantWriteCheck({
      className: 'ChannelParticipantBanned',
      bannedRights: { sendMessages: false, sendPhotos: true },
    })).toEqual({ canWrite: true });
  });

  it('blocks left participants and missing payloads', () => {
    expect(getChannelParticipantWriteCheck({ className: 'ChannelParticipantLeft' })).toEqual({ canWrite: false });
    expect(getChannelParticipantWriteCheck(undefined)).toEqual({ canWrite: false });
  });
});

describe('getIsPermanentParticipantError', () => {
  it('classifies definitive access failures as permanent', () => {
    expect(getIsPermanentParticipantError(
      'RPCError 400: USER_NOT_PARTICIPANT (caused by channels.GetParticipant)',
    )).toBe(true);
    expect(getIsPermanentParticipantError(
      'RPCError 400: USER_BANNED_IN_CHANNEL (caused by channels.GetParticipant)',
    )).toBe(true);
    expect(getIsPermanentParticipantError('RPCError 400: CHANNEL_PRIVATE')).toBe(true);
  });

  it('treats transport and flood failures as transient', () => {
    expect(getIsPermanentParticipantError('RPCError 420: FLOOD_WAIT_30')).toBe(false);
    expect(getIsPermanentParticipantError('TimeoutError: WebSocket closed')).toBe(false);
  });
});

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
