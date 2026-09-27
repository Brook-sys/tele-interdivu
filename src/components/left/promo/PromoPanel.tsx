import { memo, useEffect, useMemo } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat, ApiChatFullInfo } from '../../../api/types';
import type { PromoCategoryId, PromoChatStatus, PromoSettings } from '../../../global/types/promo';
import { LeftColumnContent } from '../../../types';

import { ALL_FOLDER_ID } from '../../../config';
import { selectPromoSettings, selectPromoUserState } from '../../../global/selectors/promo';
import buildClassName from '../../../util/buildClassName';
import { buildPromoSections } from '../../../util/promo/buildSections';
import { getSlowmodeRemainingSeconds } from '../../../util/promo/classifyChat';

import useFlag from '../../../hooks/useFlag';
import { useFolderManagerForOrderedIds } from '../../../hooks/useFolderManager';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';
import { usePromoServerNow } from '../../../hooks/usePromoServerNow';
import { useStateRef } from '../../../hooks/useStateRef';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import PromoChatRow from './PromoChatRow';
import PromoPanelSettings from './PromoPanelSettings';

import styles from './PromoPanel.module.scss';

const STATUS_REFRESH_INTERVAL_MS = 60_000;

type OwnProps = {
  isActive: boolean;
  onReset: () => void;
};

type StateProps = {
  settings: PromoSettings;
  chatsById: Record<string, ApiChat>;
  fullInfoById: Record<string, ApiChatFullInfo>;
  statusById: Record<string, PromoChatStatus>;
};

const CATEGORY_LANG_KEYS: Record<PromoCategoryId, 'PromoCategoryFree' | 'PromoCategorySlowmode'
  | 'PromoCategoryStars'> = {
  free: 'PromoCategoryFree',
  slowmode: 'PromoCategorySlowmode',
  stars: 'PromoCategoryStars',
};

const CATEGORY_ICON_BY_ID: Record<PromoCategoryId, 'check' | 'clock' | 'star'> = {
  free: 'check',
  slowmode: 'clock',
  stars: 'star',
};

const PromoPanel = ({
  isActive,
  onReset,
  settings,
  chatsById,
  fullInfoById,
  statusById,
}: OwnProps & StateProps) => {
  const { requestPromoStatuses, openLeftColumnContent } = getActions();
  const lang = useLang();
  const [isSettingsOpen, openSettings, closeSettings] = useFlag();
  const serverNow = usePromoServerNow(isActive && !isSettingsOpen);

  const folderId = settings.folderId;
  const isSetupMode = !folderId;

  useHistoryBack({
    isActive: isActive && !isSettingsOpen && !isSetupMode,
    onBack: onReset,
  });

  const orderedIds = useFolderManagerForOrderedIds(folderId ?? ALL_FOLDER_ID);
  const orderedIdsRef = useStateRef(orderedIds);

  const sections = useMemo(() => {
    if (!folderId || !orderedIds) return undefined;

    return buildPromoSections({
      orderedChatIds: orderedIds,
      chatsById,
      fullInfoById,
      statusById,
      categoryOrder: settings.categoryOrder,
      sortCriteriaByCategoryId: settings.sortCriteriaByCategoryId,
      serverNow,
      locale: lang.code,
    });
  }, [
    folderId, orderedIds, chatsById, fullInfoById, statusById,
    settings.categoryOrder, settings.sortCriteriaByCategoryId, serverNow, lang.code,
  ]);

  useEffect(() => {
    if (!isActive || !folderId) return undefined;

    const requestStatuses = () => {
      const chatIds = orderedIdsRef.current;
      if (chatIds?.length) {
        requestPromoStatuses({ chatIds });
      }
    };

    requestStatuses();

    const interval = window.setInterval(requestStatuses, STATUS_REFRESH_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
    };
  }, [isActive, folderId, orderedIdsRef, requestPromoStatuses]);

  const handleOpenSettings = useLastCallback(() => {
    openSettings();
  });

  const handleCloseSettings = useLastCallback(() => {
    if (isSetupMode) {
      onReset();
      return;
    }
    closeSettings();
  });

  const handleOpenManage = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.PromoManage });
  });

  const handleOpenAutomation = useLastCallback(() => {
    openLeftColumnContent({ contentKey: LeftColumnContent.PromoAutomation });
  });

  if (isSettingsOpen || isSetupMode) {
    return (
      <PromoPanelSettings
        isActive={isActive}
        onReset={handleCloseSettings}
      />
    );
  }

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
        <h3>{lang('PromoPanelTitle')}</h3>
        <div className={styles.headerButtons}>
          <Button
            round
            size="smaller"
            color="translucent"
            ariaLabel={lang('PromoAutomationTitle')}
            iconName="bots"
            onClick={handleOpenAutomation}
          />
          <Button
            round
            size="smaller"
            color="translucent"
            ariaLabel={lang('PromoMenuManage')}
            iconName="folder-tabs-group"
            onClick={handleOpenManage}
          />
          <Button
            round
            size="smaller"
            color="translucent"
            ariaLabel={lang('PromoSettingsTitle')}
            iconName="settings"
            onClick={handleOpenSettings}
          />
        </div>
      </div>
      <div className={buildClassName(styles.scrollable, 'custom-scroll')}>
        {sections?.map(({ categoryId, chatIds }) => (
          <div key={categoryId} className={styles.section}>
            <div className={styles.sectionHeader}>
              <Icon name={CATEGORY_ICON_BY_ID[categoryId]} className={styles.sectionIcon} />
              <span className={styles.sectionTitle}>{lang(CATEGORY_LANG_KEYS[categoryId])}</span>
              <span className={styles.sectionCount}>{chatIds.length}</span>
            </div>
            {chatIds.length ? chatIds.map((chatId) => (
              <PromoChatRow
                key={chatId}
                chat={chatsById[chatId]}
                slowmodeRemaining={getSlowmodeRemainingSeconds(
                  fullInfoById[chatId],
                  statusById[chatId],
                  serverNow,
                )}
              />
            )) : (
              <div className={styles.emptyText}>{lang('PromoEmptySection')}</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    const { statusById } = selectPromoUserState(global);

    return {
      settings: selectPromoSettings(global),
      chatsById: global.chats.byId,
      fullInfoById: global.chats.fullInfoById,
      statusById,
    };
  },
)(PromoPanel));
