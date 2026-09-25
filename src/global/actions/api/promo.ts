import type { RequiredGlobalActions } from '../../index';
import type { ActionReturnType } from '../../types';

import { pause } from '../../../util/schedulers';
import { getServerTime } from '../../../util/serverTime';
import { callApi } from '../../../api/gramjs';
import { addActionHandler, getGlobal, setGlobal } from '../../index';
import { recordPromoFullInfoFetch } from '../../reducers/promo';
import { selectChat, selectChatFolder } from '../../selectors/chats';
import { selectPromoChatStatus, selectPromoSettings } from '../../selectors/promo';
import { loadFullChat } from './chats';

const PROMO_FULL_INFO_TTL_SECONDS = 600;
const PROMO_REQUEST_INTERVAL_MS = 1500;
const PROMO_BULK_INTERVAL_MS = 500;
const PROMO_GENERIC_BACKOFF_SECONDS = 60;

// Serialized full-info queue with a global pause window shared by all promo requests
const queuedChatIds = new Set<string>();
let isQueueActive = false;
let floodBackoffUntil = 0;

addActionHandler('requestPromoStatuses', (global, actions, payload): ActionReturnType => {
  const { chatIds } = payload;

  chatIds.forEach((chatId) => {
    queuedChatIds.add(chatId);
  });

  if (floodBackoffUntil > getServerTime() || isQueueActive) return;

  isQueueActive = true;
  void runPromoStatusQueue(actions);
});

async function runPromoStatusQueue(actions: RequiredGlobalActions) {
  try {
    while (queuedChatIds.size) {
      if (floodBackoffUntil > getServerTime()) break;

      const chatId = queuedChatIds.values().next().value;
      if (chatId === undefined) break;
      queuedChatIds.delete(chatId);

      let global = getGlobal();
      const fetchedAt = selectPromoChatStatus(global, chatId)?.fullInfoFetchedAt;
      if (fetchedAt && getServerTime() - fetchedAt < PROMO_FULL_INFO_TTL_SECONDS) continue;

      const chat = selectChat(global, chatId);
      if (!chat) continue;

      const result = await loadFullChat(global, actions, chat);
      if (result) {
        global = getGlobal();
        global = recordPromoFullInfoFetch(global, chatId, getServerTime());
        setGlobal(global);
      } else {
        // `fetchFullChat` swallows the raw error, so the wait time is not exposed — apply a
        // conservative generic backoff and let the next panel refresh resume the queue
        floodBackoffUntil = getServerTime() + PROMO_GENERIC_BACKOFF_SECONDS;
        break;
      }

      await pause(PROMO_REQUEST_INTERVAL_MS);
    }
  } finally {
    isQueueActive = false;
  }
}

addActionHandler('setPromoChatsVisibility', async (global, actions, payload): Promise<void> => {
  const { chatIds, isVisible } = payload;
  const folderId = selectPromoSettings(global).folderId;
  if (folderId === undefined) return;

  for (const chatId of chatIds) {
    const currentGlobal = getGlobal();
    const folder = selectChatFolder(currentGlobal, folderId);
    if (!folder) return;

    const isIncluded = folder.includedChatIds.includes(chatId);
    if (isIncluded === isVisible) continue;

    const folderUpdate = {
      ...folder,
      includedChatIds: isVisible
        ? [...folder.includedChatIds, chatId]
        : folder.includedChatIds.filter((id) => id !== chatId),
      pinnedChatIds: isVisible ? folder.pinnedChatIds : folder.pinnedChatIds?.filter((id) => id !== chatId),
    };

    await callApi('editChatFolder', {
      id: folderId,
      folderUpdate,
    });

    await pause(PROMO_BULK_INTERVAL_MS);
  }
});
