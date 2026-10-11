import { useEffect } from '../lib/teact/teact';

import {
  addChatsCountCallback,
  addOrderedIdsCallback, addUnreadChatsByFolderIdCallback,
  addUnreadCountersCallback,
  getChatsCount,
  getOrderedIds, getUnreadChatsByFolderId,
  getUnreadCounters,
} from '../util/folderManager';
import useForceUpdate from './useForceUpdate';

export function useFolderManagerForOrderedIds(folderId: number) {
  const forceUpdate = useForceUpdate();

  useEffect(() => addOrderedIdsCallback(folderId, forceUpdate), [folderId, forceUpdate]);

  return getOrderedIds(folderId);
}

// Union of the ordered lists of several folders; `undefined` while any of them
// is still being computed (same loading contract as the single-folder hook)
export function useFolderManagerForUnionOrderedIds(folderIds: number[]) {
  const forceUpdate = useForceUpdate();

  useEffect(() => {
    const unsubscribers = folderIds.map((folderId) => addOrderedIdsCallback(folderId, forceUpdate));
    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [folderIds, forceUpdate]);

  const orderedLists = folderIds.map((folderId) => getOrderedIds(folderId));
  if (orderedLists.some((orderedIds) => orderedIds === undefined)) return undefined;

  const seen = new Set<string>();
  const union: string[] = [];
  orderedLists.forEach((orderedIds) => {
    orderedIds!.forEach((chatId) => {
      if (!seen.has(chatId)) {
        seen.add(chatId);
        union.push(chatId);
      }
    });
  });
  return union;
}

export function useFolderManagerForUnreadCounters() {
  const forceUpdate = useForceUpdate();

  useEffect(() => addUnreadCountersCallback(forceUpdate), [forceUpdate]);

  return getUnreadCounters();
}

export function useFolderManagerForChatsCount() {
  const forceUpdate = useForceUpdate();

  useEffect(() => addChatsCountCallback(forceUpdate), [forceUpdate]);

  return getChatsCount();
}

export function useFolderManagerForUnreadChatsByFolder() {
  const forceUpdate = useForceUpdate();

  useEffect(() => addUnreadChatsByFolderIdCallback(forceUpdate), [forceUpdate]);

  return getUnreadChatsByFolderId();
}
