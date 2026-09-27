import type { ChangeEvent } from 'react';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat, ApiChatFolder } from '../../../api/types';
import type { PromoSettings } from '../../../global/types/promo';

import { selectPromoSettings } from '../../../global/selectors/promo';
import buildClassName from '../../../util/buildClassName';
import {
  type AutomationGroupState,
  type AutomationLogItem,
  type AutomationStatusResponse,
  fetchAutomationGroups,
  fetchAutomationLogs,
  fetchAutomationStatus,
  saveAutomationCampaign,
  saveAutomationConfig,
  startAutomationTakeover,
  stopAutomationRelease,
  testSpintaxPreviews,
} from '../../../util/promo/automationApi';
import { loadStoredSession } from '../../../util/sessions';
import { callApi } from '../../../api/gramjs';

import useFlag from '../../../hooks/useFlag';
import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Button from '../../ui/Button';
import Checkbox from '../../ui/Checkbox';
import InputText from '../../ui/InputText';
import Radio from '../../ui/Radio';
import Spinner from '../../ui/Spinner';

import styles from './PromoAutomation.module.scss';

type OwnProps = {
  isActive: boolean;
  onReset: () => void;
};

type StateProps = {
  settings: PromoSettings;
  chatsById: Record<string, ApiChat>;
  foldersById: Record<number, ApiChatFolder>;
};

type TabType = 'campaign' | 'settings' | 'queue' | 'logs';

const STATUS_REFRESH_INTERVAL_MS = 3000;

const PromoAutomation = ({
  isActive,
  onReset,
  settings,
  chatsById,
  foldersById,
}: OwnProps & StateProps) => {
  const { initApi } = getActions();
  const lang = useLang();

  const [activeTab, setActiveTab] = useState<TabType>('campaign');
  const [statusData, setStatusData] = useState<AutomationStatusResponse | undefined>();
  const [groupsData, setGroupsData] = useState<AutomationGroupState[]>([]);
  const [logsData, setLogsData] = useState<AutomationLogItem[]>([]);
  const [isLoading, _markLoading, unmarkLoading] = useFlag(true);
  const [isSubmitting, markSubmitting, unmarkSubmitting] = useFlag();
  const [actionError, setActionError] = useState<string | undefined>();
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | undefined>();

  // Guard to initialize form inputs from the server only on first load,
  // preventing periodic status polling from overwriting user edits.
  const isFormInitializedRef = useRef(false);

  // Campaign form state
  const [spintaxTemplate, setSpintaxTemplate] = useState('');
  const [linksText, setLinksText] = useState('');
  const [linkPreview, setLinkPreview] = useState(false);
  const [previews, setPreviews] = useState<string[]>([]);

  // Settings form state
  const [mode, setMode] = useState<'manual' | 'continuous'>('manual');
  const [minDelay, setMinDelay] = useState('60');
  const [maxDelay, setMaxDelay] = useState('180');
  const [roundInterval, setRoundInterval] = useState('120');
  const [minOtherMsgs, setMinOtherMsgs] = useState('5');
  const [sleepEnabled, setSleepEnabled] = useState(true);
  const [sleepStart, setSleepStart] = useState('23:30');
  const [sleepEnd, setSleepEnd] = useState('07:30');
  const [dailyLimit, setDailyLimit] = useState('80');

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const folder = settings.folderId !== undefined ? foldersById[settings.folderId] : undefined;
  const targetChatIds = useMemo(() => folder?.includedChatIds || [], [folder]);

  const loadStatusAndData = useLastCallback(async () => {
    try {
      const res = await fetchAutomationStatus();
      setStatusData(res);

      if (!isFormInitializedRef.current) {
        isFormInitializedRef.current = true;

        if (res.campaign) {
          setSpintaxTemplate(res.campaign.spintaxTemplate || '');
          setLinksText((res.campaign.links || []).join('\n'));
        }

        if (res.config) {
          setMode(res.config.mode || 'manual');
          setMinDelay(String(res.config.minDelaySeconds ?? 60));
          setMaxDelay(String(res.config.maxDelaySeconds ?? 180));
          setRoundInterval(String(res.config.roundIntervalMinutes ?? 120));
          setMinOtherMsgs(String(res.config.minOtherMessages ?? 5));
          setSleepEnabled(Boolean(res.config.sleepWindowEnabled));
          setSleepStart(res.config.sleepWindowStart || '23:30');
          setSleepEnd(res.config.sleepWindowEnd || '07:30');
          setDailyLimit(String(res.config.dailyLimit ?? 80));
          setLinkPreview(Boolean(res.config.linkPreviewEnabled));
        }
      }

      if (activeTab === 'queue') {
        const groups = await fetchAutomationGroups();
        setGroupsData(groups);
      } else if (activeTab === 'logs') {
        const logs = await fetchAutomationLogs(50);
        setLogsData(logs);
      }
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkLoading();
    }
  });

  useEffect(() => {
    if (!isActive) return undefined;

    loadStatusAndData();
    const interval = window.setInterval(loadStatusAndData, STATUS_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, [isActive, activeTab, loadStatusAndData]);

  const handleStart = useLastCallback(async () => {
    setActionError(undefined);
    markSubmitting();

    try {
      const sessionData = loadStoredSession();
      if (!sessionData) {
        throw new Error('Sessão do Telegram não encontrada no navegador.');
      }

      const targetChats = targetChatIds.map((id) => {
        const chat = chatsById[id];
        return {
          id,
          title: chat?.title || `Chat ${id}`,
          accessHash: chat?.accessHash,
        };
      });

      if (!targetChats.length) {
        throw new Error('Nenhum grupo na pasta de divulgação selecionada.');
      }

      // 1. Disconnect browser client so the daemon takes over exclusively
      await callApi('disconnect');

      // 2. Handover session to backend
      await startAutomationTakeover({
        sessionData,
        targetChats,
      });

      await loadStatusAndData();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const handleStop = useLastCallback(async () => {
    setActionError(undefined);
    markSubmitting();

    try {
      // 1. Stop backend daemon and release session
      await stopAutomationRelease();

      // 2. Reconnect browser client
      initApi();

      await loadStatusAndData();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const handleSaveCampaign = useLastCallback(async () => {
    setActionError(undefined);
    setSaveSuccessMsg(undefined);
    markSubmitting();

    try {
      const links = linksText.split('\n').map((l) => l.trim()).filter(Boolean);
      await saveAutomationCampaign(spintaxTemplate, links);
      await saveAutomationConfig({ linkPreviewEnabled: linkPreview });
      setSaveSuccessMsg(lang('PromoAutomationSaved'));
      setTimeout(() => setSaveSuccessMsg(undefined), 3000);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const handleTestPreviews = useLastCallback(async () => {
    setActionError(undefined);
    try {
      const links = linksText.split('\n').map((l) => l.trim()).filter(Boolean);
      const res = await testSpintaxPreviews(spintaxTemplate, links);
      setPreviews(res.previews.map((p) => p.messageText));
    } catch (err: any) {
      setActionError(err.message);
    }
  });

  const handleSaveConfig = useLastCallback(async () => {
    setActionError(undefined);
    setSaveSuccessMsg(undefined);
    markSubmitting();

    try {
      await saveAutomationConfig({
        mode,
        minDelaySeconds: Number(minDelay) || 60,
        maxDelaySeconds: Number(maxDelay) || 180,
        roundIntervalMinutes: Number(roundInterval) || 120,
        minOtherMessages: Number(minOtherMsgs) || 1,
        sleepWindowEnabled: sleepEnabled,
        sleepWindowStart: sleepStart,
        sleepWindowEnd: sleepEnd,
        dailyLimit: Number(dailyLimit) || 80,
        linkPreviewEnabled: linkPreview,
      });
      setSaveSuccessMsg(lang('PromoAutomationSaved'));
      setTimeout(() => setSaveSuccessMsg(undefined), 3000);
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const isRunning = statusData?.isRunning;

  const renderStatusBanner = () => {
    const status = statusData?.status || 'STOPPED';

    let badgeClass = styles.badgeStopped;
    let label = lang('PromoAutomationStopped');

    if (status === 'RUNNING') {
      badgeClass = styles.badgeRunning;
      label = lang('PromoAutomationRunning');
    } else if (status === 'SLEEP_WINDOW') {
      badgeClass = styles.badgeSleep;
      label = lang('PromoAutomationSleepWindow');
    } else if (status === 'MICRO_PAUSE') {
      badgeClass = styles.badgeMicroPause;
      label = lang('PromoAutomationMicroPause');
    } else if (status === 'CIRCUIT_BREAKER') {
      badgeClass = styles.badgeCircuit;
      label = lang('PromoAutomationCircuitBreaker');
    }

    return (
      <div className={styles.statusBanner}>
        <div className={buildClassName(styles.statusBadge, badgeClass)}>
          <span className={styles.statusDot} />
          <span>{label}</span>
        </div>
        <div className={styles.controls}>
          {isRunning ? (
            <Button
              color="danger"
              size="smaller"
              disabled={isSubmitting}
              onClick={handleStop}
            >
              {lang('PromoAutomationStop')}
            </Button>
          ) : (
            <Button
              color="primary"
              size="smaller"
              disabled={isSubmitting || !folder}
              onClick={handleStart}
            >
              {lang('PromoAutomationStart')}
            </Button>
          )}
        </div>
      </div>
    );
  };

  const renderStats = () => {
    if (!statusData?.stats) return undefined;
    const { stats } = statusData;

    return (
      <div className={styles.statsGrid}>
        <div className={styles.statCard}>
          <div className={styles.statValue}>
            {stats.todaySent}
            {' / '}
            {stats.dailyLimit}
          </div>
          <div className={styles.statLabel}>Enviados Hoje</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{stats.readyCount}</div>
          <div className={styles.statLabel}>Prontos</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{stats.waitingMessagesCount}</div>
          <div className={styles.statLabel}>Aguardando Msgs</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{stats.waitingSlowmodeCount}</div>
          <div className={styles.statLabel}>Em Slowmode</div>
        </div>
      </div>
    );
  };

  const renderTabsHeader = () => {
    return (
      <div className={styles.tabsHeader}>
        <button
          type="button"
          className={buildClassName(styles.tabBtn, activeTab === 'campaign' && styles.tabBtnActive)}
          onClick={() => setActiveTab('campaign')}
        >
          {lang('PromoAutomationCampaignTab')}
        </button>
        <button
          type="button"
          className={buildClassName(styles.tabBtn, activeTab === 'settings' && styles.tabBtnActive)}
          onClick={() => setActiveTab('settings')}
        >
          {lang('PromoAutomationSettingsTab')}
        </button>
        <button
          type="button"
          className={buildClassName(styles.tabBtn, activeTab === 'queue' && styles.tabBtnActive)}
          onClick={() => setActiveTab('queue')}
        >
          {lang('PromoAutomationQueueTab')}
        </button>
        <button
          type="button"
          className={buildClassName(styles.tabBtn, activeTab === 'logs' && styles.tabBtnActive)}
          onClick={() => setActiveTab('logs')}
        >
          {lang('PromoAutomationLogsTab')}
        </button>
      </div>
    );
  };

  const renderCampaignTab = () => {
    return (
      <div className={styles.tabContent}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{lang('PromoAutomationSpintaxLabel')}</label>
          <textarea
            className={styles.textarea}
            rows={5}
            value={spintaxTemplate}
            placeholder="{Olá|Oi|E aí} pessoal, confiram {esse link|essa novidade}: {LINK}"
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setSpintaxTemplate(e.target.value)}
          />
        </div>

        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>{lang('PromoAutomationLinksLabel')}</label>
          <textarea
            className={styles.textarea}
            rows={3}
            value={linksText}
            placeholder="https://t.me/seucanal&#10;https://t.me/seugrupo"
            onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setLinksText(e.target.value)}
          />
        </div>

        <div className={styles.checkboxRow}>
          <Checkbox
            checked={linkPreview}
            onCheck={setLinkPreview}
            label={lang('PromoAutomationLinkPreview')}
          />
        </div>

        <div className={styles.btnRow}>
          <Button size="smaller" color="translucent" onClick={handleTestPreviews}>
            {lang('PromoAutomationTestSpintax')}
          </Button>
          <Button size="smaller" color="primary" disabled={isSubmitting} onClick={handleSaveCampaign}>
            {lang('PromoAutomationSave')}
          </Button>
        </div>

        {previews.length > 0 && (
          <div className={styles.previewsContainer}>
            <div className={styles.previewsHeader}>Exemplos Gerados:</div>
            {previews.map((prev, idx) => (
              <div key={idx} className={styles.previewBox}>{prev}</div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderSettingsTab = () => {
    return (
      <div className={styles.tabContent}>
        <div className={styles.fieldGroup}>
          <label className={styles.fieldLabel}>Modo de Execução</label>
          <div className={styles.radioGroup}>
            <Radio
              name="mode"
              value="manual"
              checked={mode === 'manual'}
              label={lang('PromoAutomationModeManual')}
              onChange={() => setMode('manual')}
            />
            <Radio
              name="mode"
              value="continuous"
              checked={mode === 'continuous'}
              label={lang('PromoAutomationModeContinuous')}
              onChange={() => setMode('continuous')}
            />
          </div>
        </div>

        <div className={styles.twoCols}>
          <InputText
            label={lang('PromoAutomationMinDelay')}
            value={minDelay}
            inputMode="numeric"
            onChange={(e) => setMinDelay(e.target.value)}
          />
          <InputText
            label={lang('PromoAutomationMaxDelay')}
            value={maxDelay}
            inputMode="numeric"
            onChange={(e) => setMaxDelay(e.target.value)}
          />
        </div>

        {mode === 'continuous' && (
          <InputText
            label={lang('PromoAutomationRoundInterval')}
            value={roundInterval}
            inputMode="numeric"
            onChange={(e) => setRoundInterval(e.target.value)}
          />
        )}

        <InputText
          label={lang('PromoAutomationMinOtherMessages')}
          value={minOtherMsgs}
          inputMode="numeric"
          onChange={(e) => setMinOtherMsgs(e.target.value)}
        />

        <InputText
          label={lang('PromoAutomationDailyLimit')}
          value={dailyLimit}
          inputMode="numeric"
          onChange={(e) => setDailyLimit(e.target.value)}
        />

        <div className={styles.checkboxRow}>
          <Checkbox
            checked={sleepEnabled}
            onCheck={setSleepEnabled}
            label={lang('PromoAutomationSleepWindowToggle')}
          />
        </div>

        {sleepEnabled && (
          <div className={styles.twoCols}>
            <InputText
              label={lang('PromoAutomationSleepStart')}
              value={sleepStart}
              onChange={(e) => setSleepStart(e.target.value)}
            />
            <InputText
              label={lang('PromoAutomationSleepEnd')}
              value={sleepEnd}
              onChange={(e) => setSleepEnd(e.target.value)}
            />
          </div>
        )}

        <div className={styles.btnRow}>
          <Button size="smaller" color="primary" disabled={isSubmitting} onClick={handleSaveConfig}>
            {lang('PromoAutomationSave')}
          </Button>
        </div>
      </div>
    );
  };

  const renderQueueTab = () => {
    return (
      <div className={styles.tabContent}>
        {groupsData.length === 0 ? (
          <div className={styles.emptyText}>Nenhum grupo na fila de automação ainda.</div>
        ) : (
          groupsData.map((g) => (
            <div key={g.chatId} className={styles.queueRow}>
              <div className={styles.queueMain}>
                <span className={styles.queueTitle}>{g.title}</span>
                <span className={styles.queueSub}>
                  Msgs de terceiros:
                  {' '}
                  {g.otherMessagesCount}
                  {' / '}
                  {minOtherMsgs}
                </span>
              </div>
              <span className={buildClassName(
                styles.queueBadge,
                g.status === 'READY' && styles.queueReady,
                g.status === 'WAITING_SLOWMODE' && styles.queueSlow,
                g.status === 'WAITING_MESSAGES' && styles.queueWait,
                g.status === 'BLOCKED' && styles.queueBlocked,
              )}
              >
                {g.status}
              </span>
            </div>
          ))
        )}
      </div>
    );
  };

  const renderLogsTab = () => {
    return (
      <div className={styles.tabContent}>
        {logsData.length === 0 ? (
          <div className={styles.emptyText}>Nenhum log registrado ainda.</div>
        ) : (
          logsData.map((log, idx) => (
            <div key={idx} className={styles.logRow}>
              <div className={styles.logTop}>
                <span className={styles.logTitle}>{log.chatTitle}</span>
                <span className={buildClassName(
                  styles.logStatus,
                  log.status === 'SUCCESS' && styles.logSuccess,
                  log.status === 'FLOOD_WAIT' && styles.logFlood,
                  log.status === 'ERROR' && styles.logError,
                )}
                >
                  {log.status}
                </span>
              </div>
              <div className={styles.logSnippet}>{log.messageSnippet}</div>
              {log.details && <div className={styles.logDetails}>{log.details}</div>}
            </div>
          ))
        )}
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
        <h3>{lang('PromoAutomationTitle')}</h3>
      </div>

      <div className={buildClassName(styles.scrollable, 'custom-scroll')}>
        {actionError && <div className={styles.errorBox}>{actionError}</div>}
        {saveSuccessMsg && <div className={styles.successBox}>{saveSuccessMsg}</div>}

        {renderStatusBanner()}
        {renderStats()}
        {renderTabsHeader()}

        {isLoading ? (
          <div className={styles.loadingWrap}>
            <Spinner />
          </div>
        ) : (
          <>
            {activeTab === 'campaign' && renderCampaignTab()}
            {activeTab === 'settings' && renderSettingsTab()}
            {activeTab === 'queue' && renderQueueTab()}
            {activeTab === 'logs' && renderLogsTab()}
          </>
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal<OwnProps>(
  (global): Complete<StateProps> => {
    return {
      settings: selectPromoSettings(global),
      chatsById: global.chats.byId,
      foldersById: global.chatFolders.byId,
    };
  },
)(PromoAutomation));
