import type { AutomationDatabase } from '../db/database';

import { TELEGRAM_API_HASH, TELEGRAM_API_ID } from '../../src/config';
import { Api as GramJs, errors, sessions } from '../../src/lib/gramjs';

import TelegramClient from '../../src/lib/gramjs/client/TelegramClient';
import { setProxyRelayOrigin } from '../../src/lib/gramjs/extensions/PromisedWebSockets';

export interface TargetChatInfo {
  id: string;
  title: string;
  accessHash?: string;
}

const CHANNEL_ID_BASE = 1000000000000n;

function buildInputPeerForChat(chatId: string, accessHash?: string): GramJs.TypeInputPeer {
  const n = BigInt(chatId);
  if (chatId.startsWith('-100')) {
    const channelId = -n - CHANNEL_ID_BASE;
    return new GramJs.InputPeerChannel({
      channelId,
      accessHash: accessHash ? BigInt(accessHash) : 0n,
    });
  }

  if (chatId.startsWith('-')) {
    return new GramJs.InputPeerChat({
      chatId: -n,
    });
  }

  return new GramJs.InputPeerUser({
    userId: n,
    accessHash: accessHash ? BigInt(accessHash) : 0n,
  });
}

function getChatIdFromMtpPeer(peer: any): string {
  if (peer.channelId !== undefined) {
    const chId = BigInt(peer.channelId);
    return ((chId + CHANNEL_ID_BASE) * -1n).toString();
  }

  if (peer.chatId !== undefined) {
    const cId = BigInt(peer.chatId);
    return (cId * -1n).toString();
  }

  if (peer.userId !== undefined) {
    return peer.userId.toString();
  }

  return '';
}

export class TelegramRunner {
  private client?: TelegramClient;

  private targetChatMap = new Map<string, TargetChatInfo>();

  private isConnected = false;

  constructor(
    private readonly db: AutomationDatabase,
    private readonly proxyPort = 3000,
  ) {}

  getIsConnected(): boolean {
    return this.isConnected;
  }

  async start(
    sessionData: any,
    targetChats: TargetChatInfo[],
  ): Promise<void> {
    if (this.client) {
      await this.stop();
    }

    this.targetChatMap.clear();
    targetChats.forEach((chat) => {
      this.targetChatMap.set(chat.id, chat);
    });

    // If a proxy or relay is configured, route MTProto WebSockets through local proxy relay
    if (process.env.PROXY_URL) {
      setProxyRelayOrigin(`http://127.0.0.1:${this.proxyPort}`);
    }

    const session = new sessions.CallbackSession(sessionData, (updatedSession) => {
      if (updatedSession) {
        this.db.saveSession(JSON.stringify(updatedSession));
      }
    });

    const client = new TelegramClient(
      session,
      TELEGRAM_API_ID,
      TELEGRAM_API_HASH,
      {
        deviceModel: 'Interdivu Automation Daemon',
        systemVersion: 'Linux',
        appVersion: '1.0.0',
        useWSS: true,
      },
    );

    const eventBuilder = { build: (u: any) => u } as any;
    client.addEventHandler((update: any) => {
      this.handleUpdate(update);
    }, eventBuilder);

    await client.connect();
    this.client = client;
    this.isConnected = true;
  }

  stop(): Promise<void> {
    this.isConnected = false;
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // Ignore disconnect errors
      }
      this.client = undefined;
    }
    return Promise.resolve();
  }

  private handleUpdate(update: any) {
    const message = update?.message;
    if (!message || !message.peerId) return;

    try {
      const chatId = getChatIdFromMtpPeer(message.peerId);
      if (!this.targetChatMap.has(chatId)) return;

      if (message.out) {
        // Message sent by our account in this group: reset other messages counter
        this.db.resetGroupOtherMessages(chatId, message.date);
      } else {
        // Message sent by another member: increment other messages counter
        this.db.incrementGroupOtherMessages(chatId);
      }
    } catch {
      // Ignore update parsing errors
    }
  }

  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<{ success: boolean; floodWaitSeconds?: number; error?: string }> {
    if (!this.client || !this.isConnected) {
      return { success: false, error: 'Telegram runner is not connected' };
    }

    const chatInfo = this.targetChatMap.get(chatId);
    if (!chatInfo) {
      return { success: false, error: `Chat ${chatId} not found in target groups` };
    }

    const peer = buildInputPeerForChat(chatId, chatInfo.accessHash);
    const config = this.db.getConfig();

    // 1. Send typing action to appear organic
    try {
      await this.client.invoke(new GramJs.messages.SetTyping({
        peer,
        action: new GramJs.SendMessageTypingAction(),
      }));
      // Wait 3 to 5 seconds during typing simulation
      const typingMs = 3000 + Math.floor(Math.random() * 2000);
      await new Promise((r) => setTimeout(r, typingMs));
    } catch {
      // Non-fatal if typing action fails
    }

    // 2. Send the message
    try {
      const randomId = BigInt(Math.floor(Math.random() * 1e15));
      await this.client.invoke(new GramJs.messages.SendMessage({
        peer,
        message: text,
        randomId,
        noWebpage: !config.linkPreviewEnabled ? true : undefined,
      }));

      return { success: true };
    } catch (err: any) {
      const message = String(err?.message || err);

      if (err instanceof errors.SlowModeWaitError || /SLOWMODE_WAIT_(\d+)/.test(message)) {
        const match = message.match(/SLOWMODE_WAIT_(\d+)/);
        const seconds = match ? Number(match[1]) : (err.seconds || 60);
        return { success: false, floodWaitSeconds: seconds, error: `Slowmode wait: ${seconds}s` };
      }

      if (err instanceof errors.FloodWaitError || /FLOOD_WAIT_(\d+)/.test(message)) {
        const match = message.match(/FLOOD_WAIT_(\d+)/);
        const seconds = match ? Number(match[1]) : (err.seconds || 60);
        return { success: false, floodWaitSeconds: seconds, error: `Flood wait: ${seconds}s` };
      }

      if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE/.test(message)) {
        this.db.upsertGroupState({
          chatId,
          title: chatInfo.title,
          status: 'BLOCKED',
          lastError: message,
          otherMessagesCount: 0,
          slowmodeSeconds: 0,
        });
        return { success: false, error: message };
      }

      return { success: false, error: message };
    }
  }
}
