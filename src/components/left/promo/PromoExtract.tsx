import {
  memo,
  useEffect,
  useState,
} from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import {
  clearExtractedLinks,
  downloadExtractedLinks,
  type ExtractedLinkItem,
  type ExtractStatsResponse,
  fetchExtractedLinks,
  fetchExtractStats,
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
  onReset: () => void;
};

type ExtractTab = 'invite_link' | 'tg_link' | 'external_link';

const LIST_LIMIT = 200;
const REFRESH_INTERVAL_MS = 10_000;

const PromoExtract = ({ isActive, onReset }: OwnProps) => {
  const [items, setItems] = useState<ExtractedLinkItem[]>([]);
  const [stats, setStats] = useState<ExtractStatsResponse>();
  const [activeTab, setActiveTab] = useState<ExtractTab>('invite_link');
  const [searchQuery, setSearchQuery] = useState('');
  const [actionError, setActionError] = useState<string>();
  const [isLoading, startLoading, stopLoading] = useFlag(true);
  const [isSubmitting, markSubmitting, unmarkSubmitting] = useFlag();

  useHistoryBack({
    isActive,
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
  }, [isActive, activeTab, searchQuery]);

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

  const handleExport = useLastCallback(async () => {
    markSubmitting();
    try {
      await downloadExtractedLinks(activeTab);
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
        <Button
          round
          size="smaller"
          color="translucent"
          ariaLabel="Return to chat list"
          iconName="arrow-left"
          onClick={onReset}
        />
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
          placeholder={lang('PromoExtractSearchPlaceholder')}
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className={styles.actionsRow}>
          <Button size="smaller" disabled={isSubmitting || !items.length} onClick={handleExport}>
            {lang('PromoExtractExport')}
          </Button>
          <Button size="smaller" color="danger" disabled={isSubmitting || !items.length} onClick={handleClear}>
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
            {items.map((item) => (
              <div key={`${item.kind}:${item.value}`} className={styles.listItem}>
                <div className={styles.linkValue}>{item.value}</div>
                <div className={styles.itemMeta}>
                  <span>{item.sourceChatTitle}</span>
                  <span>
                    {lang('PromoExtractTimesSeen', { count: item.timesSeen }, { pluralValue: item.timesSeen })}
                  </span>
                  <span>{new Date(item.lastSeenAt * 1000).toLocaleString(lang.code)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default memo(PromoExtract);
