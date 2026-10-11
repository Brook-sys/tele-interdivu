import { memo, useMemo, useRef } from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChatFolder } from '../../../api/types';
import type {
  PromoCategoryId, PromoSettings, PromoSortCriteria,
} from '../../../global/types/promo';
import { PROMO_FOLDER_CHAT_LIMIT } from '../../../global/types/promo';

import { selectPromoSettings } from '../../../global/selectors/promo';
import buildClassName from '../../../util/buildClassName';
import download from '../../../util/download';
import {
  parsePromoSettings, serializePromoSettings,
} from '../../../util/promo/settingsSerialization';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import DropdownMenu from '../../ui/DropdownMenu';
import MenuItem from '../../ui/MenuItem';

import styles from './PromoPanelSettings.module.scss';

type OwnProps = {
  isActive: boolean;
  onReset: () => void;
};

type StateProps = {
  settings: PromoSettings;
  foldersById: Record<number, ApiChatFolder>;
  orderedFolderIds?: number[];
};

const CATEGORY_LANG_KEYS: Record<PromoCategoryId, 'PromoCategoryFree' | 'PromoCategorySlowmode'
  | 'PromoCategoryStars'> = {
  free: 'PromoCategoryFree',
  slowmode: 'PromoCategorySlowmode',
  stars: 'PromoCategoryStars',
};

const SORT_LANG_KEYS: Record<PromoSortCriteria, 'PromoSortAlphabetical' | 'PromoSortStarsCost'
  | 'PromoSortSlowmodeRemaining'> = {
  alphabetical: 'PromoSortAlphabetical',
  starsCost: 'PromoSortStarsCost',
  slowmodeRemaining: 'PromoSortSlowmodeRemaining',
};

const ALLOWED_SORT_CRITERIA_BY_CATEGORY: Record<PromoCategoryId, PromoSortCriteria[]> = {
  free: ['alphabetical', 'starsCost'],
  slowmode: ['alphabetical', 'slowmodeRemaining'],
  stars: ['alphabetical', 'starsCost'],
};

const CATEGORY_ICON_BY_ID: Record<PromoCategoryId, 'check' | 'clock' | 'star'> = {
  free: 'check',
  slowmode: 'clock',
  stars: 'star',
};

const SETTINGS_FILE_NAME = 'telegram-promo-settings.json';
const NO_FOLDER_IDS: number[] = [];

const PromoPanelSettings = ({
  isActive,
  onReset,
  settings,
  foldersById,
  orderedFolderIds,
}: OwnProps & StateProps) => {
  const { setPromoSettings } = getActions();
  const lang = useLang();
  const [isImportError, markImportError, clearImportError] = useFlag();
  const importInputRef = useRef<HTMLInputElement>();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const folders = useMemo(
    () => (orderedFolderIds || []).map((id) => foldersById[id]).filter(Boolean),
    [foldersById, orderedFolderIds],
  );

  const selectedFolderIds = settings.folderIds ?? NO_FOLDER_IDS;
  const selectedFolders = useMemo(
    () => folders.filter((folder) => selectedFolderIds.includes(folder.id)),
    [folders, selectedFolderIds],
  );
  // Honest pool size: a chat inside two selected folders counts once
  const totalChatCount = useMemo(
    () => new Set(selectedFolders.flatMap((folder) => folder.includedChatIds)).size,
    [selectedFolders],
  );

  const handleToggleFolder = useLastCallback((folderId: number) => {
    clearImportError();
    const isSelected = selectedFolderIds.includes(folderId);
    const nextFolderIds = isSelected
      ? selectedFolderIds.filter((id) => id !== folderId)
      : [...selectedFolderIds, folderId];

    setPromoSettings({ patch: { folderIds: nextFolderIds.length ? nextFolderIds : undefined } });
  });

  const handleClearFolders = useLastCallback(() => {
    clearImportError();
    setPromoSettings({ patch: { folderIds: undefined } });
  });

  const handleMoveCategory = useLastCallback((categoryId: PromoCategoryId, offset: -1 | 1) => {
    const { categoryOrder } = settings;
    const index = categoryOrder.indexOf(categoryId);
    const targetIndex = index + offset;
    if (index === -1 || targetIndex < 0 || targetIndex >= categoryOrder.length) return;

    const nextOrder = [...categoryOrder];
    nextOrder.splice(index, 1);
    nextOrder.splice(targetIndex, 0, categoryId);

    setPromoSettings({ patch: { categoryOrder: nextOrder } });
  });

  const handleSelectSortCriteria = useLastCallback((categoryId: PromoCategoryId, criteria: PromoSortCriteria) => {
    clearImportError();
    setPromoSettings({
      patch: {
        sortCriteriaByCategoryId: {
          ...settings.sortCriteriaByCategoryId,
          [categoryId]: criteria,
        },
      },
    });
  });

  const handleExport = useLastCallback(() => {
    const file = new File([serializePromoSettings(settings)], SETTINGS_FILE_NAME, { type: 'application/json' });
    const url = URL.createObjectURL(file);
    download(url, SETTINGS_FILE_NAME);
  });

  const handleImportChange = useLastCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        markImportError();
        return;
      }

      const parsed = parsePromoSettings(reader.result);
      if (!parsed) {
        markImportError();
        return;
      }
      clearImportError();
      setPromoSettings({ patch: parsed });
    };
    reader.readAsText(file);
  });

  const handleImportClick = useLastCallback(() => {
    importInputRef.current?.click();
  });

  const renderFolderRow = (folder: ApiChatFolder) => {
    const isSelected = selectedFolderIds.includes(folder.id);
    const isFull = folder.includedChatIds.length >= PROMO_FOLDER_CHAT_LIMIT;

    return (
      <div
        key={folder.id}
        role="button"
        tabIndex={0}
        onClick={() => handleToggleFolder(folder.id)}
        className={buildClassName(styles.folderRow, isSelected && styles.folderRowSelected)}
      >
        <div className={buildClassName(styles.folderCheck, isSelected && styles.folderCheckActive)}>
          {isSelected && <Icon name="check" className={styles.folderCheckIcon} />}
        </div>
        <span className={styles.folderTitle}>{folder.title.text}</span>
        <span className={buildClassName(styles.folderChatCount, isFull && styles.folderChatCountFull)}>
          {folder.includedChatIds.length}
        </span>
      </div>
    );
  };

  const renderCategoryRow = (categoryId: PromoCategoryId, index: number) => {
    const criteria = settings.sortCriteriaByCategoryId[categoryId];
    const allowedCriteria = ALLOWED_SORT_CRITERIA_BY_CATEGORY[categoryId];

    return (
      <div key={categoryId} className={styles.categoryRow}>
        <div className={styles.categoryMain}>
          <Icon name={CATEGORY_ICON_BY_ID[categoryId]} className={styles.categoryIcon} />
          <span className={styles.categoryTitle}>{lang(CATEGORY_LANG_KEYS[categoryId])}</span>
          <div className={styles.categoryOrderButtons}>
            <Button
              round
              size="tiny"
              color="translucent"
              iconName="up"
              ariaLabel="Move up"
              disabled={index === 0}
              onClick={() => handleMoveCategory(categoryId, -1)}
            />
            <Button
              round
              size="tiny"
              color="translucent"
              iconName="down"
              ariaLabel="Move down"
              disabled={index === settings.categoryOrder.length - 1}
              onClick={() => handleMoveCategory(categoryId, 1)}
            />
          </div>
        </div>
        <div className={styles.categorySort}>
          <span className={styles.sortLabel}>{lang('PromoSettingsSortBy')}</span>
          <DropdownMenu className={styles.sortDropdown} positionX="right">
            {allowedCriteria.map((option) => (
              <MenuItem
                key={option}
                icon={option === criteria ? 'check' : undefined}
                onClick={() => handleSelectSortCriteria(categoryId, option)}
              >
                {lang(SORT_LANG_KEYS[option])}
              </MenuItem>
            ))}
          </DropdownMenu>
        </div>
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
        <h3>{lang('PromoSettingsTitle')}</h3>
      </div>
      <div className={buildClassName(styles.scrollable, 'custom-scroll')}>
        <div className={styles.section}>
          <span className={styles.sectionLabel}>{lang('PromoSettingsFolder')}</span>
          {folders.length ? (
            <div className={styles.folderList}>
              <div
                role="button"
                tabIndex={0}
                onClick={handleClearFolders}
                className={buildClassName(
                  styles.folderRow,
                  !selectedFolderIds.length && styles.folderRowSelected,
                )}
              >
                <div
                  className={buildClassName(
                    styles.folderCheck,
                    !selectedFolderIds.length && styles.folderCheckActive,
                  )}
                >
                  {!selectedFolderIds.length && <Icon name="check" className={styles.folderCheckIcon} />}
                </div>
                <span className={styles.folderTitle}>{lang('PromoSettingsFolderNone')}</span>
              </div>
              {folders.map(renderFolderRow)}
            </div>
          ) : (
            <div className={styles.folderHint}>{lang('PromoSetupFolderHint')}</div>
          )}
          {totalChatCount > 0 && (
            <div className={styles.selectedFolderName}>
              {lang('PromoSettingsFolderTotalChats', { count: totalChatCount }, { pluralValue: totalChatCount })}
            </div>
          )}
          {folders.length > 0 && (
            <div className={styles.folderHint}>{lang('PromoSettingsFolderMultiHint')}</div>
          )}
        </div>
        <div className={styles.section}>
          <span className={styles.sectionLabel}>{lang('PromoSettingsSectionOrder')}</span>
          {settings.categoryOrder.map(renderCategoryRow)}
        </div>
        <div className={buildClassName(styles.section, styles.importExportSection)}>
          <Button
            size="smaller"
            color="translucent"
            onClick={handleExport}
          >
            {lang('PromoSettingsExport')}
          </Button>
          <Button
            size="smaller"
            color="translucent"
            onClick={handleImportClick}
          >
            {lang('PromoSettingsImport')}
          </Button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json"
            className={styles.importInput}
            onChange={handleImportChange}
          />
          {isImportError && (
            <div className={styles.importError}>{lang('PromoSettingsImportError')}</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    return {
      settings: selectPromoSettings(global),
      foldersById: global.chatFolders.byId,
      orderedFolderIds: global.chatFolders.orderedIds,
    };
  },
)(PromoPanelSettings));
