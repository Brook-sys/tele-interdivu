import {
  memo,
  useEffect,
  useState,
} from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import {
  clearExtractedLinks,
  downloadExtractedLinks,
  type ExtractedLinkItem,
  type ExtractStatsResponse,
  fetchExtractedLinks,
  fetchExtractStats,
  resolveExtractedLink,
  saveAutomationConfig,
} from '../../../util/promo/automationApi';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import Spinner from '../../ui/Spinner';

import styles from './PromoExtract.module.scss';

type OwnProps = {
  isActive: boolean;
  // Rendered inside the full-screen AutomationMode (no back button)
  isEmbedded?: boolean;
  onReset: () => void;
};

type ExtractTab = 'invite_link' | 'tg_link' | 'external_link';

const LIST_LIMIT = 200;
const REFRESH_INTERVAL_MS = 10_000;

const PromoExtract = ({ isActive, isEmbedded, onReset }: OwnProps) => {
  const [items, setItems] = useState<ExtractedLinkItem[]>([]);
  const [stats, setStats] = useState<ExtractStatsResponse>();
  const [activeTab, setActiveTab] = useState<ExtractTab>('invite_link');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState<string>();
  const [isLoading, startLoading, stopLoading] = useFlag(true);
  const [isSubmitting, markSubmitting, unmarkSubmitting] = useFlag();
  const [copiedValue, setCopiedValue] = useState<string>();
  const [resolvingValue, setResolvingValue] = useState<string>();
  const [sortBy, setSortBy] = useState<'recent' | 'seen'>('recent');

  useHistoryBack({
    // Embedded in AutomationMode: navigation/history is owned by the parent shell
    isActive: isActive && !isEmbedded,
    onBack: onReset,
  });

  const lang = useLang();

  const load = useLastCallback(async (withSpinner = false) => {
    if (withSpinner) startLoading();
    try {
      const [list, extractStats] = await Promise.all([
        fetchExtractedLinks({
          kind: activeTab,
          q: searchQuery.trim() || undefined,
          limit: LIST_LIMIT,
          sort: sortBy,
        }),
        fetchExtractStats(),
      ]);
      setItems(list);
      setStats(extractStats);
      setActionError(undefined);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      if (withSpinner) stopLoading();
    }
  });

  useEffect(() => {
    if (!isActive) return undefined;

    load(true);
    const interval = window.setInterval(() => {
      load();
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [isActive, activeTab, searchQuery, sortBy]);

  const handleToggleExtractor = useLastCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.checked;
    markSubmitting();
    try {
      await saveAutomationConfig({ extractorEnabled: value });
      setStats((current) => (current ? { ...current, enabled: value } : current));
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const handleCopy = useLastCallback((value: string) => {
    copyTextToClipboard(value);
    setCopiedValue(value);
    setTimeout(() => setCopiedValue(undefined), 1500);
  });

  const handleResolve = useLastCallback(async (item: ExtractedLinkItem) => {
    setResolvingValue(item.value);
    setActionError(undefined);
    try {
      await resolveExtractedLink(item.kind, item.value);
      await load();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setResolvingValue(undefined);
    }
  });

  const handleClear = useLastCallback(async () => {
    markSubmitting();
    try {
      await clearExtractedLinks(activeTab);
      await load();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const handleExport = useLastCallback(async (format: 'txt' | 'csv', scopeAll: boolean) => {
    markSubmitting();
    try {
      await downloadExtractedLinks(scopeAll ? undefined : activeTab, format);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const statFor = (kind: string) => stats?.byKind.find((entry) => entry.kind === kind);

  return (
    <div className={styles.root}>
      <div className="left-header">
        {!isEmbedded && (
          <Button
            round
            size="smaller"
            color="translucent"
            ariaLabel="Return to chat list"
            iconName="arrow-left"
            onClick={onReset}
          />
        )}
        <h3>{lang('PromoExtractTitle')}</h3>
      </div>

      <div className={buildClassName(styles.scrollable, 'custom-scroll')}>
        {actionError && <div className={styles.errorBox}>{actionError}</div>}

        <div className={styles.toggleRow}>
          <Checkbox
            label={lang('PromoExtractEnabled')}
            checked={stats?.enabled !== false}
            disabled={isSubmitting}
            onChange={handleToggleExtractor}
          />
        </div>

        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{statFor('invite_link')?.total || 0}</div>
            <div className={styles.statLabel}>{lang('PromoExtractInvites')}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{statFor('tg_link')?.total || 0}</div>
            <div className={styles.statLabel}>{lang('PromoExtractTgLinks')}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{statFor('external_link')?.total || 0}</div>
            <div className={styles.statLabel}>{lang('PromoExtractExternal')}</div>
          </div>
        </div>

        <div className={styles.tabsHeader}>
          {(['invite_link', 'tg_link', 'external_link'] as ExtractTab[]).map((tab) => (
            <button
              key={tab}
              className={buildClassName(styles.tabButton, activeTab === tab && styles.activeTab)}
              onClick={() => setActiveTab(tab)}
            >
              {tab === 'invite_link'
                ? lang('PromoExtractInvites')
                : tab === 'tg_link' ? lang('PromoExtractTgLinks') : lang('PromoExtractExternal')}
            </button>
          ))}
        </div>

        <InputText
          noMargin
          placeholder={lang('PromoExtractSearchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className={styles.actionsRow}>
          <Button
            fluid
            size="smaller"
            color="translucent"
            onClick={() => setSortBy(sortBy === 'recent' ? 'seen' : 'recent')}
          >
            {sortBy === 'recent' ? lang('PromoExtractSortRecent') : lang('PromoExtractSortSeen')}
          </Button>
        </div>
        <div className={styles.actionsRow}>
          <Button
            fluid
            size="smaller"
            disabled={isSubmitting || !items.length}
            onClick={() => handleExport('txt', false)}
          >
            {lang('PromoExtractExportTxt')}
          </Button>
          <Button
            fluid
            size="smaller"
            disabled={isSubmitting || !items.length}
            onClick={() => handleExport('csv', false)}
          >
            {lang('PromoExtractExportCsv')}
          </Button>
          <Button
            fluid
            size="smaller"
            disabled={isSubmitting}
            onClick={() => handleExport('csv', true)}
          >
            {lang('PromoExtractExportCsvAll')}
          </Button>
          <Button
            fluid
            size="smaller"
            color="danger"
            disabled={isSubmitting || !items.length}
            onClick={handleClear}
          >
            {lang('PromoExtractClear')}
          </Button>
        </div>

        {isLoading ? (
          <div className={styles.loadingWrap}>
            <Spinner />
          </div>
        ) : (
          <div className={styles.list}>
            {!items.length && (
              <div className={styles.hint}>{lang('PromoExtractEmpty')}</div>
            )}
            {items.map((item) => {
              const isCopyFeedback = copiedValue === item.value;
              const isResolving = resolvingValue === item.value;
              const canResolve = item.kind === 'invite_link' && !item.resolvedTitle && !item.resolvedFailed;
              return (
                <div key={`${item.kind}:${item.value}`} className={styles.listItem}>
                  <div className={styles.linkRow}>
                    <div
                      className={styles.linkValue}
                      title={lang('PromoExtractClickToCopy')}
                      onClick={() => handleCopy(item.value)}
                    >
                      {item.value}
                    </div>
                    <div className={styles.linkActions}>
                      <Button
                        round
                        size="smaller"
                        color="translucent"
                        ariaLabel={lang('PromoExtractCopy')}
                        iconName="copy"
                        onClick={() => handleCopy(item.value)}
                      />
                      {canResolve && (
                        <Button
                          round
                          size="smaller"
                          color="translucent"
                          ariaLabel={lang('PromoExtractResolve')}
                          iconName="search"
                          disabled={isResolving}
                          onClick={() => handleResolve(item)}
                        />
                      )}
                    </div>
                  </div>
                  {isCopyFeedback && (
                    <div className={styles.copiedHint}>{lang('PromoExtractCopied')}</div>
                  )}
                  {item.resolvedFailed && (
                    <div className={styles.resolvedFailed}>{lang('PromoExtractInviteInvalid')}</div>
                  )}
                  {item.resolvedTitle && (
                    <div className={styles.resolvedCard}>
                      {item.resolvedPhotoB64 && (
                        <img className={styles.resolvedPhoto} src={item.resolvedPhotoB64} alt="" />
                      )}
                      <div
                        className={styles.resolvedText}
                        title={item.resolvedAbout || undefined}
                      >
                        <div className={styles.resolvedTitle}>{item.resolvedTitle}</div>
                        <div className={styles.resolvedMeta}>
                          <span>
                            {lang(
                              item.resolvedType === 'channel'
                                ? 'PromoExtractTypeChannel' : 'PromoExtractTypeGroup',
                            )}
                          </span>
                          {item.resolvedMembers !== undefined && (
                            <span>
                              {lang(
                                'PromoExtractMembers',
                                { count: item.resolvedMembers },
                                { pluralValue: item.resolvedMembers },
                              )}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                  <div className={styles.itemMeta}>
                    <span>{item.sourceChatTitle}</span>
                    <span>
                      {lang('PromoExtractTimesSeen', { count: item.timesSeen }, { pluralValue: item.timesSeen })}
                    </span>
                    <span>{new Date(item.lastSeenAt * 1000).toLocaleString(lang.code)}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(PromoExtract);
