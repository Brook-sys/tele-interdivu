import { memo, useMemo, useState } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat, ApiChatFolder } from '../../../api/types';

import { selectPromoSettings } from '../../../global/selectors/promo';
import buildClassName from '../../../util/buildClassName';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Avatar from '../../common/Avatar';
import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import InputText from '../../ui/InputText';

import styles from './PromoManageGroups.module.scss';

type OwnProps = {
  isActive: boolean;
  onReset: () => void;
};

type StateProps = {
  folderIds: number[];
  foldersById: Record<number, ApiChatFolder>;
  chatsById: Record<string, ApiChat>;
  activeListIds?: string[];
  archivedListIds?: string[];
};

const NO_FOLDER_IDS: number[] = [];
const MANAGED_CHAT_TYPES: ApiChat['type'][] = ['chatTypeBasicGroup', 'chatTypeSuperGroup'];

const PromoManageGroups = ({
  isActive,
  onReset,
  folderIds,
  foldersById,
  chatsById,
  activeListIds,
  archivedListIds,
}: OwnProps & StateProps) => {
  const { setPromoChatsVisibility } = getActions();
  const lang = useLang();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const hasSelectedFolders = folderIds.length > 0;
  const selectedFolders = useMemo(
    () => folderIds.map((id) => foldersById[id]).filter(Boolean),
    [folderIds, foldersById],
  );
  // A chat inside any selected folder counts as visible (hiding removes it
  // from every folder that includes it)
  const includedChatIds = useMemo(() => {
    const seen = new Set<string>();
    selectedFolders.forEach((folder) => {
      folder.includedChatIds.forEach((chatId) => {
        if (!seen.has(chatId)) {
          seen.add(chatId);
        }
      });
    });
    return [...seen];
  }, [selectedFolders]);
  const visibleIdSet = useMemo(() => new Set(includedChatIds), [includedChatIds]);

  const filteredChatIds = useMemo(() => {
    const allIds = [...(activeListIds || []), ...(archivedListIds || [])];
    const query = searchQuery.trim().toLowerCase();

    return allIds.filter((chatId) => {
      const chat = chatsById[chatId];
      if (!chat || !MANAGED_CHAT_TYPES.includes(chat.type)) return false;
      return !query || chat.title.toLowerCase().includes(query);
    });
  }, [chatsById, activeListIds, archivedListIds, searchQuery]);

  const areAllFilteredSelected = filteredChatIds.length > 0
    && filteredChatIds.every((chatId) => selectedIds.has(chatId));

  const toggleSelection = useLastCallback((chatId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(chatId)) {
        next.delete(chatId);
      } else {
        next.add(chatId);
      }
      return next;
    });
  });

  const handleRowClick = useLastCallback((chatId: string) => {
    toggleSelection(chatId);
  });

  const handleToggleVisibility = useLastCallback((chatId: string, isVisible: boolean) => {
    setPromoChatsVisibility({ chatIds: [chatId], isVisible });
  });

  const handleToggleSelectAll = useLastCallback(() => {
    setSelectedIds((current) => {
      if (areAllFilteredSelected) {
        const next = new Set(current);
        filteredChatIds.forEach((chatId) => {
          next.delete(chatId);
        });
        return next;
      }

      const next = new Set(current);
      filteredChatIds.forEach((chatId) => {
        next.add(chatId);
      });
      return next;
    });
  });

  const applyVisibility = useLastCallback((isVisible: boolean) => {
    if (!selectedIds.size) return;
    setPromoChatsVisibility({ chatIds: [...selectedIds], isVisible });
    setSelectedIds(new Set());
  });

  const renderRow = (chatId: string) => {
    const chat = chatsById[chatId];
    const isVisible = visibleIdSet.has(chatId);
    const isSelected = selectedIds.has(chatId);

    return (
      <div
        key={chatId}
        role="button"
        tabIndex={0}
        onClick={() => handleRowClick(chatId)}
        className={buildClassName(styles.row, isSelected && styles.rowSelected)}
      >
        <div className={buildClassName(styles.checkbox, isSelected && styles.checkboxChecked)}>
          {isSelected && <Icon name="check" className={styles.checkboxIcon} />}
        </div>
        <Avatar peer={chat} size="medium" className={styles.avatar} />
        <div className={styles.title}>{chat.title}</div>
        <Button
          round
          size="tiny"
          color="translucent"
          ariaLabel={isVisible ? lang('PromoManageHideSelected') : lang('PromoManageShowSelected')}
          iconName={isVisible ? 'eye' : 'eye-crossed'}
          className={styles.visibilityButton}
          shouldStopPropagation
          onClick={() => handleToggleVisibility(chatId, !isVisible)}
        />
      </div>
    );
  };

  return (
    <div className={styles.root}>
      <div className="left-header">
        <Button
          round
          size="smaller"
          color="translucent"
          ariaLabel="Return to chat list"
          iconName="arrow-left"
          onClick={onReset}
        />
        <h3>{lang('PromoMenuManage')}</h3>
        {hasSelectedFolders && filteredChatIds.length > 0 && (
          <Button
            round
            size="smaller"
            color="translucent"
            ariaLabel={lang('PromoManageSelectAll')}
            className={styles.selectAllButton}
            iconName="select"
            onClick={handleToggleSelectAll}
          />
        )}
      </div>
      <div className={styles.searchWrapper}>
        <InputText
          className={styles.searchInput}
          value={searchQuery}
          placeholder={lang('PromoManageSearchPlaceholder')}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
      <div className={buildClassName(styles.scrollable, 'custom-scroll')}>
        {!hasSelectedFolders ? (
          <div className={styles.hint}>{lang('PromoManageNoFolder')}</div>
        ) : filteredChatIds.length ? (
          filteredChatIds.map(renderRow)
        ) : (
          <div className={styles.hint}>{lang('PromoManageNoMatches')}</div>
        )}
      </div>
      {hasSelectedFolders && selectedIds.size > 0 && (
        <div className={styles.actionBar}>
          <span className={styles.selectedCount}>
            {lang('PromoManageSelectedCount', { count: selectedIds.size }, { pluralValue: selectedIds.size })}
          </span>
          <Button
            size="smaller"
            color="danger"
            onClick={() => applyVisibility(false)}
          >
            {lang('PromoManageHideSelected')}
          </Button>
          <Button
            size="smaller"
            color="primary"
            onClick={() => applyVisibility(true)}
          >
            {lang('PromoManageShowSelected')}
          </Button>
          <Button
            size="smaller"
            color="translucent"
            ariaLabel={lang('PromoManageDeselectAll')}
            iconName="close"
            onClick={() => setSelectedIds(new Set())}
          />
        </div>
      )}
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { folderIds } = selectPromoSettings(global);

    return {
      folderIds: folderIds ?? NO_FOLDER_IDS,
      foldersById: global.chatFolders.byId,
      chatsById: global.chats.byId,
      activeListIds: global.chats.listIds.active,
      archivedListIds: global.chats.listIds.archived,
    };
  },
)(PromoManageGroups));
