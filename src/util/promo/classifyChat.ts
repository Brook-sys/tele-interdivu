import type { ApiChat, ApiChatFullInfo } from '../../api/types';
import type { PromoChatStatus } from '../../global/types/promo';

const PROMO_CHAT_TYPES: ApiChat['type'][] = ['chatTypeBasicGroup', 'chatTypeSuperGroup'];

export type PromoChatClassification = 'blocked' | 'stars' | 'slowmode' | 'free';

export function getIsPromoChatBlocked(chat: ApiChat): boolean {
  if (!PROMO_CHAT_TYPES.includes(chat.type)) return true;
  if (chat.isForbidden || chat.isNotJoined || chat.isRestricted) return true;
  if (chat.adminRights?.postMessages) return false;
  if (chat.currentUserBannedRights?.sendMessages) return true;
  if (chat.defaultBannedRights?.sendMessages) return true;

  return false;
}

export function getSlowmodeRemainingSeconds(
  fullInfo: ApiChatFullInfo | undefined,
  status: PromoChatStatus | undefined,
  serverNow: number,
): number {
  const seconds = fullInfo?.slowMode?.seconds || 0;
  if (!seconds) return 0;

  const nextSendDate = fullInfo?.slowMode?.nextSendDate;
  const lastOwnMessageAt = status?.lastOwnMessageAt;

  const fromNextSendDate = nextSendDate ? nextSendDate - serverNow : 0;
  const fromLastOwnMessage = lastOwnMessageAt ? lastOwnMessageAt + seconds - serverNow : 0;

  return Math.max(0, fromNextSendDate, fromLastOwnMessage);
}

export function classifyPromoChat(
  chat: ApiChat,
  fullInfo: ApiChatFullInfo | undefined,
  status: PromoChatStatus | undefined,
  serverNow: number,
): PromoChatClassification {
  if (getIsPromoChatBlocked(chat)) return 'blocked';
  if ((chat.paidMessagesStars || 0) > 0) return 'stars';
  if (getSlowmodeRemainingSeconds(fullInfo, status, serverNow) > 0) return 'slowmode';

  return 'free';
}
