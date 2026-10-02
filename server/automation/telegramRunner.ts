import type { AutomationDatabase } from '../db/database';

import { TELEGRAM_API_HASH, TELEGRAM_API_ID } from '../../src/config';
import { Api as GramJs, errors, sessions } from '../../src/lib/gramjs';
import { extractLinks } from './extractors/links';

import TelegramClient from '../../src/lib/gramjs/client/TelegramClient';
import { setProxyRelayOrigin } from '../../src/lib/gramjs/extensions/PromisedWebSockets';

export interface TargetChatInfo {
  id: string;
  title: string;
  accessHash?: string;
}

export interface ChatProbeResult {
  canWrite: boolean;
  starsCost?: number;
  slowmodeSeconds?: number;
}

export interface InviteResolveResult {
  title: string;
  members?: number;
  chatType: string;
  about?: string;
  photoB64?: string;
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

export function extractMessagesFromGramJsUpdate(update: any): any[] {
  if (!update || typeof update !== 'object') return [];

  if (Array.isArray(update.updates)) {
    return update.updates.flatMap((u: any) => extractMessagesFromGramJsUpdate(u));
  }

  if (update.update) {
    return extractMessagesFromGramJsUpdate(update.update);
  }

  if (update.message && typeof update.message === 'object') {
    return [update.message];
  }

  if (update.chatId !== undefined && update.message !== undefined && typeof update.message === 'string') {
    return [{
      peerId: { chatId: update.chatId },
      out: Boolean(update.out),
      date: update.date || Math.floor(Date.now() / 1000),
    }];
  }

  return [];
}

export class TelegramRunner {
  private client?: TelegramClient;

  private targetChatMap = new Map<string, TargetChatInfo>();

  private lastUpdateReceivedAt?: number;

  private totalUpdatesReceived = 0;

  private historyCheckCache = new Map<string, { lastCheckedAt: number; count: number }>();

  constructor(
    private readonly db: AutomationDatabase,
    private readonly proxyPort = 3000,
  ) {}

  private extractorEnabled = true;

  setExtractorEnabled(enabled: boolean) {
    this.extractorEnabled = enabled;
  }

  getIsConnected(): boolean {
    return Boolean(this.client?.isConnected());
  }

  getStats() {
    return {
      isConnected: this.getIsConnected(),
      targetChatsCount: this.targetChatMap.size,
      lastUpdateReceivedAt: this.lastUpdateReceivedAt,
      totalUpdatesReceived: this.totalUpdatesReceived,
    };
  }

  async start(
    sessionData: any,
    targetChats: TargetChatInfo[],
  ): Promise<void> {
    if (this.client) {
      await this.stop();
    }

    this.targetChatMap.clear();
    this.historyCheckCache.clear();
    targetChats.forEach((chat) => {
      this.targetChatMap.set(chat.id, chat);
    });

    this.extractorEnabled = this.db.getConfig().extractorEnabled;

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

    // Keep session alive periodically by fetching config every 30 minutes
    client.setPingCallback(async () => {
      try {
        await client.invoke(new GramJs.help.GetConfig());
      } catch {
        // ignore ping error
      }
    });

    const eventBuilder = { build: (u: any) => u } as any;
    client.addEventHandler((update: any) => {
      this.handleUpdate(update);
    }, eventBuilder);

    await client.connect();
    this.client = client;
  }

  async reconnect(): Promise<boolean> {
    if (!this.client) return false;
    try {
      this.client.disconnect();
      await this.client.connect();
      return this.client.isConnected();
    } catch {
      return false;
    }
  }

  stop(): Promise<void> {
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
    if (!update) return;

    this.totalUpdatesReceived++;
    this.lastUpdateReceivedAt = Date.now();

    try {
      const messages = extractMessagesFromGramJsUpdate(update);
      for (const message of messages) {
        if (!message || !message.peerId) continue;

        const chatId = getChatIdFromMtpPeer(message.peerId);
        if (!this.targetChatMap.has(chatId)) continue;

        if (message.out) {
          // Message sent by our account in this group: reset other messages counter
          this.historyCheckCache.delete(chatId);
          this.db.resetGroupOtherMessages(chatId, message.date || Math.floor(Date.now() / 1000));
        } else {
          // Message sent by another member: increment other messages counter
          const cached = this.historyCheckCache.get(chatId);
          if (cached) {
            cached.count++;
          }
          this.db.incrementGroupOtherMessages(chatId);

          // Passive extraction: links from other members' messages
          if (this.extractorEnabled) {
            this.extractFromMessage(chatId, message);
          }
        }
      }
    } catch {
      // Ignore update parsing errors
    }
  }

  private extractFromMessage(chatId: string, message: any) {
    try {
      const links = extractLinks({
        messageId: message.id,
        text: message.message,
        entities: message.entities,
      });
      if (!links.length) return;

      const chatInfo = this.targetChatMap.get(chatId);
      const senderId = message.fromId?.userId !== undefined
        ? String(message.fromId.userId) : undefined;

      for (const link of links) {
        this.db.upsertExtractedItem({
          kind: link.kind,
          value: link.value,
          domain: link.domain,
          preview: link.preview,
          sourceChatId: chatId,
          sourceChatTitle: chatInfo?.title || chatId,
          messageId: message.id,
          senderId,
        });
      }
    } catch {
      // Extraction must never break update handling
    }
  }

  async checkOtherMessagesCount(
    chatId: string,
    minRequired: number,
  ): Promise<number> {
    const groupState = this.db.getGroupState(chatId);
    const localCount = groupState?.otherMessagesCount || 0;

    // If local updates already reached minRequired, no need to touch network
    if (localCount >= minRequired) {
      return localCount;
    }

    // Rate-limit network GetHistory to once per 5 minutes per chat
    const now = Date.now();
    const cached = this.historyCheckCache.get(chatId);
    if (cached && (now - cached.lastCheckedAt) < 300_000) {
      return cached.count;
    }

    if (!this.client || !this.client.isConnected()) {
      return localCount;
    }

    const chatInfo = this.targetChatMap.get(chatId);
    if (!chatInfo) return localCount;

    const peer = buildInputPeerForChat(chatId, chatInfo.accessHash);
    const lastSentAt = groupState?.lastSentAt;

    try {
      const history = await this.client.invoke(new GramJs.messages.GetHistory({
        peer,
        limit: Math.max(minRequired + 10, 20),
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        maxId: 0,
        minId: 0,
        hash: 0n,
      })) as any;

      const messages: any[] = history?.messages || [];
      let count = 0;

      for (const msg of messages) {
        if (!msg || msg.className === 'MessageEmpty') continue;

        if (msg.out) {
          break;
        }
        if (lastSentAt && msg.date && msg.date <= lastSentAt) {
          break;
        }

        count++;
      }

      this.historyCheckCache.set(chatId, { lastCheckedAt: now, count });
      this.db.setGroupOtherMessagesCount(chatId, count);
      return count;
    } catch {
      return localCount;
    }
  }

  // Read-only probe used to revalidate quarantined groups (stars/blocked)
  // without sending anything. Returns undefined on transient failures so the
  // scheduler retries on the next cycle.
  async probeChat(chatId: string): Promise<ChatProbeResult | undefined> {
    if (!this.client || !this.client.isConnected()) return undefined;

    const chatInfo = this.targetChatMap.get(chatId);
    if (!chatInfo) return undefined;

    try {
      if (chatId.startsWith('-100')) {
        const n = BigInt(chatId);
        const channel = new GramJs.InputChannel({
          channelId: -n - CHANNEL_ID_BASE,
          accessHash: chatInfo.accessHash ? BigInt(chatInfo.accessHash) : 0n,
        });
        const result = await this.client.invoke(
          new GramJs.channels.GetFullChannel({ channel }),
        ) as any;
        const fullChat = result?.fullChat;

        // Pre-flight write check: no point trying to send when the channel
        // itself says we cannot (left the group, personally banned from
        // writing, or the group is locked for non-admins)
        const channelObj = (result?.chats || []).find((chat: any) => chat?.className === 'Channel')
          || (result?.chats || [])[0];
        const cannotWrite = Boolean(channelObj?.left)
          || channelObj?.bannedRights?.sendMessages === true
          || channelObj?.defaultBannedRights?.sendMessages === true;

        return {
          canWrite: !cannotWrite,
          starsCost: Number(fullChat?.sendPaidMessagesStars || 0),
          slowmodeSeconds: Number(fullChat?.slowmodeSeconds || 0),
        };
      }

      const result = await this.client.invoke(new GramJs.messages.GetFullChat({
        chatId: -BigInt(chatId),
      })) as any;

      return {
        canWrite: true,
        starsCost: 0,
        slowmodeSeconds: Number(result?.fullChat?.slowmodeSeconds || 0),
      };
    } catch (err: any) {
      const message = String(err?.errorMessage || err?.message || err);
      const isInaccessible = /CHANNEL_PRIVATE|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL/
        .test(message) || /CHAT_RESTRICTED|USER_NOT_PARTICIPANT/.test(message);
      if (isInaccessible) {
        return { canWrite: false };
      }

      return undefined;
    }
  }

  // Resolves an invite link (read-only, no join). photoStrippedSize ships
  // inline bytes (a few hundred B) so storing it as base64 is free.
  async resolveInviteLink(hash: string): Promise<InviteResolveResult | undefined> {
    if (!this.client || !this.client.isConnected()) return undefined;

    const result = await this.client.invoke(
      new GramJs.messages.CheckChatInvite({ hash }),
    ) as any;

    if (!result) return undefined;

    const findStrippedPhoto = (photo: any): string | undefined => {
      const stripped = photo?.sizes?.find((size: any) => (
        size?.className === 'PhotoStrippedSize' && size?.bytes
      ));
      if (!stripped) return undefined;
      const bytes = stripped.bytes instanceof Buffer
        ? stripped.bytes : Buffer.from(stripped.bytes);
      return `data:image/jpeg;base64,${bytes.toString('base64')}`;
    };

    // chatInviteAlready: our account is already a member of the target
    if (result.className === 'ChatInviteAlready') {
      const chatObj = result.chat;
      const isChannel = chatObj?.className === 'Channel';
      return {
        title: chatObj?.title || '(sem título)',
        members: chatObj?.participantsCount,
        chatType: isChannel ? (chatObj.broadcast ? 'channel' : 'group') : 'group',
        photoB64: findStrippedPhoto(chatObj?.photo),
      };
    }

    return {
      title: result.title || '(sem título)',
      members: result.participantsCount,
      chatType: result.channel
        ? (result.broadcast ? 'channel' : 'group')
        : 'group',
      about: result.about,
      photoB64: findStrippedPhoto(result.photo),
    };
  }

  async sendMessage(
    chatId: string,
    text: string,
  ): Promise<{
    success: boolean;
    isPaymentRequired?: boolean;
    isSessionLost?: boolean;
    slowmodeSeconds?: number;
    floodWaitSeconds?: number;
    error?: string;
  }> {
    if (!this.client || !this.client.isConnected()) {
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

      // Session lost to another client (e.g. the web app took over again):
      // inform the scheduler to stop instead of retrying forever
      if (/AUTH_KEY_DUPLICATED|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(message)) {
        return { success: false, isSessionLost: true, error: message };
      }

      if (/ALLOW_PAYMENT_REQUIRED/.test(message)) {
        const match = message.match(/ALLOW_PAYMENT_REQUIRED_(\d+)/);
        const stars = match ? Number(match[1]) : 1;
        this.db.setGroupStarsCost(chatId, stars);
        return {
          success: false,
          isPaymentRequired: true,
          error: `Exige pagamento de ${stars} estrelas`,
        };
      }

      if (err instanceof errors.SlowModeWaitError || /SLOWMODE_WAIT_(\d+)/.test(message)) {
        const match = message.match(/SLOWMODE_WAIT_(\d+)/);
        const seconds = match ? Number(match[1]) : (err.seconds || 60);
        const serverNow = Math.floor(Date.now() / 1000);
        this.db.setGroupSlowmode(chatId, seconds, serverNow + seconds);
        return {
          success: false,
          slowmodeSeconds: seconds,
          error: `Slowmode ativo: aguardar ${seconds}s`,
        };
      }

      if (err instanceof errors.FloodWaitError || /FLOOD_WAIT_(\d+)/.test(message)) {
        const match = message.match(/FLOOD_WAIT_(\d+)/);
        const seconds = match ? Number(match[1]) : (err.seconds || 60);
        return { success: false, floodWaitSeconds: seconds, error: `Flood wait da conta: ${seconds}s` };
      }

      if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHAT_RESTRICTED/.test(message)) {
        this.db.upsertGroupState({
          chatId,
          title: chatInfo.title,
          status: 'BLOCKED',
          lastError: message,
          otherMessagesCount: 0,
          slowmodeSeconds: 0,
          starsCost: 0,
        });
        return { success: false, error: message };
      }

      return { success: false, error: message };
    }
  }
}
