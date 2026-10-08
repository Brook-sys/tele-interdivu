import type { AutomationDatabase } from '../db/database';

import { TELEGRAM_API_HASH, TELEGRAM_API_ID } from '../../src/config';
import { Api as GramJs, errors, sessions } from '../../src/lib/gramjs';
import { extractLinks } from './extractors/links';
import { FloodWaitActiveError, ResolveGuard } from './resolveGuard';

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

// Dispatches by link shape: private invite hash or public t.me username.
// Non-Telegram links cannot be resolved and return undefined.
export function parseCampaignLinkTarget(
  url: string,
): { kind: 'invite' | 'public'; value: string } | undefined {
  const inviteMatch = url.match(/t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)/i);
  if (inviteMatch) return { kind: 'invite', value: inviteMatch[1] };

  const publicMatch = url.match(/t\.me\/([A-Za-z][A-Za-z0-9_]{3,})\/?$/i);
  if (publicMatch) return { kind: 'public', value: publicMatch[1] };

  return undefined;
}

// Full-info flags do not reflect per-user bans: a kicked account still
// resolves public supergroups without `left` or `bannedRights`, so
// channels.getParticipant is the authoritative read-only write check.
// Without it, revalidation keeps reintegrating banned groups and every
// cycle burns a real send attempt that fails with USER_BANNED_IN_CHANNEL.
export function getChannelParticipantCanWrite(participant: any): boolean {
  if (!participant) return false;

  if (participant.className === 'ChannelParticipantBanned') {
    return participant.kicked !== true && participant.bannedRights?.sendMessages !== true;
  }

  return participant.className !== 'ChannelParticipantLeft';
}

// Permanent failures mean the account definitively cannot post there
// (kicked, banned, group gone); anything else (flood, timeout) is transient
// and must leave the current quarantine untouched
export function getIsPermanentParticipantError(message: string): boolean {
  return /USER_NOT_PARTICIPANT|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHAT_WRITE_FORBIDDEN/
    .test(message) || /CHAT_RESTRICTED|USER_DEACTIVATED_BAN/.test(message);
}

// Identity of the signed-in account, captured at connect time and reported to
// the orchestration panel
export interface AccountInfo {
  userId: string;
  username?: string;
  firstName?: string;
}

export class TelegramRunner {
  private client?: TelegramClient;

  private readonly resolveGuard = new ResolveGuard();

  private targetChatMap = new Map<string, TargetChatInfo>();

  private accountInfo?: AccountInfo;

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

  // Last captured identity (memory first, persisted state as fallback so the
  // panel still knows whose account this is when the automation is disarmed)
  getAccountInfo(): AccountInfo | undefined {
    return this.accountInfo ?? this.db.getStateJson<AccountInfo>('account-info');
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
    this.accountInfo = undefined;
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

    // A failed connect must not leave an orphaned client behind: a live
    // socket keeps the auth key "in use" for Telegram, which turns every
    // retry into AUTH_KEY_DUPLICATED until the process is restarted
    try {
      await client.connect();
    } catch (err) {
      try {
        client.disconnect();
      } catch {
        // Ignore disconnect errors during cleanup
      }
      throw err;
    }
    this.client = client;

    // Identity is cosmetic for sending but required by the orchestration
    // panel, so capture it in the background without blocking the start
    void this.captureAccountInfo();
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
        const cannotWriteFromFlags = Boolean(channelObj?.left)
          || channelObj?.bannedRights?.sendMessages === true
          || channelObj?.defaultBannedRights?.sendMessages === true;

        let canWrite = !cannotWriteFromFlags;
        if (canWrite) {
          try {
            const participantResult = await this.client.invoke(
              new GramJs.channels.GetParticipant({
                channel,
                participant: new GramJs.InputPeerSelf(),
              }),
            ) as any;
            canWrite = getChannelParticipantCanWrite(participantResult?.participant);
          } catch (participantErr: any) {
            const participantMessage = String(
              participantErr?.errorMessage || participantErr?.message || participantErr,
            );
            if (getIsPermanentParticipantError(participantMessage)) {
              canWrite = false;
            } else {
              // Transient failure: report nothing so the scheduler keeps the
              // current quarantine and retries on the next sweep
              return undefined;
            }
          }
        }

        return {
          canWrite,
          starsCost: Number(fullChat?.sendPaidMessagesStars || 0),
          slowmodeSeconds: Number(fullChat?.slowmodeSeconds || 0),
        };
      }

      const result = await this.client.invoke(new GramJs.messages.GetFullChat({
        chatId: -BigInt(chatId),
      })) as any;

      // GetFullChat ships the member list, so self membership is a
      // reliable write check for basic groups (kicked accounts are absent)
      const selfUserId = await this.fetchSelfUserId();
      if (!selfUserId) return undefined;

      const participants = result?.fullChat?.participants?.participants;
      const canWrite = !Array.isArray(participants)
        || participants.some((p: any) => String(p?.userId) === selfUserId);

      return {
        canWrite,
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

  // Resolves the signed-in account's identity once per session so basic-group
  // probes can check membership and the orchestration panel can show which
  // account this daemon drives
  private async captureAccountInfo(): Promise<void> {
    if (!this.client || !this.client.isConnected()) return;
    try {
      const result = await this.client.invoke(
        new GramJs.users.GetUsers({ id: [new GramJs.InputUserSelf()] }),
      ) as any;
      const user = result?.[0];
      if (user?.id === undefined) return;
      this.accountInfo = {
        userId: String(user.id),
        username: user.username || undefined,
        firstName: user.firstName || undefined,
      };
      this.db.saveStateJson('account-info', this.accountInfo);
    } catch {
      // Identity is cosmetic — probes fall back to per-call resolution
    }
  }

  private async fetchSelfUserId(): Promise<string | undefined> {
    if (this.accountInfo?.userId) return this.accountInfo.userId;
    await this.captureAccountInfo();
    return this.accountInfo?.userId;
  }

  // photoStrippedSize ships inline bytes (a few hundred B), so storing it
  // as base64 is free
  private extractStrippedPhotoB64(photo: any): string | undefined {
    const stripped = photo?.sizes?.find((size: any) => (
      size?.className === 'PhotoStrippedSize' && size?.bytes
    ));
    if (!stripped) return undefined;
    const bytes = stripped.bytes instanceof Buffer
      ? stripped.bytes : Buffer.from(stripped.bytes);
    return `data:image/jpeg;base64,${bytes.toString('base64')}`;
  }

  // Resolves an invite link (read-only, no join)
  async resolveInviteLink(hash: string): Promise<InviteResolveResult | undefined> {
    if (!this.client || !this.client.isConnected()) return undefined;

    const cacheKey = `invite:${hash}`;
    const cached = this.resolveGuard.getCached<InviteResolveResult>(cacheKey);
    if (cached) return cached;

    this.resolveGuard.assertNotFlooded();
    await this.resolveGuard.awaitPace();

    let result: any;
    try {
      result = await this.client.invoke(
        new GramJs.messages.CheckChatInvite({ hash }),
      ) as any;
    } catch (err) {
      const floodSeconds = this.resolveGuard.registerFlood(err);
      if (floodSeconds !== undefined) throw new FloodWaitActiveError(floodSeconds);
      throw err;
    }

    if (!result) return undefined;

    let resolved: InviteResolveResult;

    // chatInviteAlready: our account is already a member of the target
    if (result.className === 'ChatInviteAlready') {
      const chatObj = result.chat;
      const isChannel = chatObj?.className === 'Channel';
      resolved = {
        title: chatObj?.title || '(sem título)',
        members: chatObj?.participantsCount,
        chatType: isChannel ? (chatObj.broadcast ? 'channel' : 'group') : 'group',
        photoB64: this.extractStrippedPhotoB64(chatObj?.photo),
      };
    } else {
      resolved = {
        title: result.title || '(sem título)',
        members: result.participantsCount,
        chatType: result.channel
          ? (result.broadcast ? 'channel' : 'group')
          : 'group',
        about: result.about,
        photoB64: this.extractStrippedPhotoB64(result.photo),
      };
    }

    this.resolveGuard.store(cacheKey, resolved);
    return resolved;
  }

  // Resolves a public t.me/username destination (read-only)
  async resolvePublicUsername(username: string): Promise<InviteResolveResult | undefined> {
    if (!this.client || !this.client.isConnected()) return undefined;

    const cacheKey = `user:${username}`;
    const cached = this.resolveGuard.getCached<InviteResolveResult>(cacheKey);
    if (cached) return cached;

    this.resolveGuard.assertNotFlooded();
    await this.resolveGuard.awaitPace();

    let resolvedData: any;
    try {
      resolvedData = await this.client.invoke(
        new GramJs.contacts.ResolveUsername({ username }),
      ) as any;
    } catch (err) {
      const floodSeconds = this.resolveGuard.registerFlood(err);
      if (floodSeconds !== undefined) throw new FloodWaitActiveError(floodSeconds);
      throw err;
    }

    const chat = (resolvedData?.chats || [])[0];
    if (!chat) return undefined;

    const isChannel = chat.className === 'Channel';
    let members: number | undefined;
    let about: string | undefined;

    try {
      if (isChannel) {
        const full = await this.client.invoke(new GramJs.channels.GetFullChannel({
          channel: new GramJs.InputChannel({
            channelId: chat.id,
            accessHash: chat.accessHash,
          }),
        })) as any;
        members = full?.fullChat?.participantsCount;
        about = full?.fullChat?.about;
      } else if (chat.className === 'Chat') {
        const full = await this.client.invoke(new GramJs.messages.GetFullChat({
          chatId: chat.id,
        })) as any;
        const participants = full?.fullChat?.participants?.participants;
        members = Array.isArray(participants) ? participants.length : undefined;
      }
    } catch {
      // Full info unavailable (e.g. restricted/left chat): basics still apply
    }

    const resolved: InviteResolveResult = {
      title: chat.title || '(sem título)',
      members,
      chatType: isChannel ? (chat.broadcast ? 'channel' : 'group') : 'group',
      about,
      photoB64: this.extractStrippedPhotoB64(chat.photo),
    };

    this.resolveGuard.store(cacheKey, resolved);
    return resolved;
  }

  async resolveCampaignLink(url: string): Promise<InviteResolveResult | undefined> {
    const target = parseCampaignLinkTarget(url);
    if (!target) return undefined;

    return target.kind === 'invite'
      ? this.resolveInviteLink(target.value)
      : this.resolvePublicUsername(target.value);
  }

  // Sends one compiled message to Saved Messages (own account) so the user
  // can see exactly how the campaign content renders — one message per click
  async sendTestMessage(text: string): Promise<{ success: boolean; error?: string }> {
    if (!this.client || !this.client.isConnected()) {
      return { success: false, error: 'Telegram runner is not connected' };
    }

    const config = this.db.getConfig();
    try {
      const randomId = BigInt(Math.floor(Math.random() * 1e15));
      await this.client.invoke(new GramJs.messages.SendMessage({
        peer: new GramJs.InputPeerSelf(),
        message: text,
        randomId,
        // Mirrors the campaign's preview-card behavior in the test render
        noWebpage: !config.linkPreviewEnabled ? true : undefined,
      }));
      return { success: true };
    } catch (err: any) {
      const message = String(err?.errorMessage || err?.message || err);
      return { success: false, error: message };
    }
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
