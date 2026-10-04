import type { ChangeEvent } from 'react';
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from '../../../lib/teact/teact';
import { getActions, withGlobal } from '../../../global';

import type { ApiChat, ApiChatFolder, ApiChatFullInfo } from '../../../api/types';
import type { PromoChatStatus, PromoSettings } from '../../../global/types/promo';

import { selectPromoSettings, selectPromoUserState } from '../../../global/selectors/promo';
import buildClassName from '../../../util/buildClassName';
import { copyTextToClipboard } from '../../../util/clipboard';
import {
  type AutomationCampaign,
  type AutomationCampaignLink,
  type AutomationCampaignTemplate,
  type AutomationGroupState,
  type AutomationLogItem,
  type AutomationStatusResponse,
  deleteCampaignLink,
  deleteCampaignTemplate,
  fetchAutomationCampaign,
  fetchAutomationDebug,
  fetchAutomationGroups,
  fetchAutomationLogs,
  fetchAutomationStatus,
  forceNewAutomationRound,
  reconnectAutomationTelegram,
  saveAutomationConfig,
  saveCampaignLink,
  saveCampaignTemplate,
  skipAutomationPause,
  startAutomationTakeover,
  stopAutomationRelease,
} from '../../../util/promo/automationApi';
import { classifyPromoChat, getSlowmodeRemainingSeconds } from '../../../util/promo/classifyChat';
import { formatCountdownSeconds } from '../../../util/promo/countdownFormat';
import {
  compileSpunMessage,
  countMessageVariations,
  pickTemplate,
  validateSpintaxSyntax,
} from '../../../util/promo/spintax';
import { getServerTime } from '../../../util/serverTime';
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
  // Rendered inside the full-screen AutomationMode (no back button, stop exits the mode)
  isEmbedded?: boolean;
  onReset: () => void;
};

type StateProps = {
  settings: PromoSettings;
  chatsById: Record<string, ApiChat>;
  foldersById: Record<number, ApiChatFolder>;
  fullInfoById: Record<string, ApiChatFullInfo>;
  promoStatusById: Record<string, PromoChatStatus>;
};

type TabType = 'campaign' | 'settings' | 'queue' | 'logs' | 'debug';

const STATUS_REFRESH_INTERVAL_MS = 3000;

// Below this number of unique messages the resend volume starts visibly repeating
const MIN_HEALTHY_VARIATIONS = 50;

const PromoAutomation = ({
  isActive,
  isEmbedded,
  onReset,
  settings,
  chatsById,
  foldersById,
  fullInfoById,
  promoStatusById,
}: OwnProps & StateProps) => {
  const { initApi } = getActions();
  const lang = useLang();

  const [activeTab, setActiveTab] = useState<TabType>('campaign');
  const [statusData, setStatusData] = useState<AutomationStatusResponse | undefined>();
  const [groupsData, setGroupsData] = useState<AutomationGroupState[]>([]);
  const [logsData, setLogsData] = useState<AutomationLogItem[]>([]);
  const [debugData, setDebugData] = useState<any>();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [isLoading, _markLoading, unmarkLoading] = useFlag(true);
  const [isSubmitting, markSubmitting, unmarkSubmitting] = useFlag();
  const [actionError, setActionError] = useState<string | undefined>();
  const [saveSuccessMsg, setSaveSuccessMsg] = useState<string | undefined>();

  // Guard to initialize form inputs from the server only on first load,
  // preventing periodic status polling from overwriting user edits.
  const isFormInitializedRef = useRef(false);

  // Campaign state
  const [campaign, setCampaign] = useState<AutomationCampaign | undefined>();
  const [rotationEnabled, setRotationEnabled] = useState(false);
  const [linkPreview, setLinkPreview] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<{
    id?: number;
    title: string;
    content: string;
    weight: string;
  } | undefined>();
  const [previewSeed, setPreviewSeed] = useState(0);
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [copiedUrl, setCopiedUrl] = useState<string | undefined>();

  // Settings form state
  const [mode, setMode] = useState<'manual' | 'continuous'>('manual');
  const [minDelay, setMinDelay] = useState('60');
  const [maxDelay, setMaxDelay] = useState('180');
  const [roundInterval, setRoundInterval] = useState('120');
  const [roundTargetSends, setRoundTargetSends] = useState('23');
  const [minOtherMsgs, setMinOtherMsgs] = useState('5');
  const [minResendInterval, setMinResendInterval] = useState('10');
  const [sleepEnabled, setSleepEnabled] = useState(true);
  const [sleepStart, setSleepStart] = useState('23:30');
  const [sleepEnd, setSleepEnd] = useState('07:30');
  const [dailyLimit, setDailyLimit] = useState('80');
  const [microPauseEnabled, setMicroPauseEnabled] = useState(true);
  const [microPauseEveryMin, setMicroPauseEveryMin] = useState('6');
  const [microPauseEveryMax, setMicroPauseEveryMax] = useState('10');
  const [microPauseSeconds, setMicroPauseSeconds] = useState('300');

  useHistoryBack({
    // Embedded in AutomationMode: navigation/history is owned by the parent shell
    isActive: isActive && !isEmbedded,
    onBack: onReset,
  });

  useEffect(() => {
    if (!isActive) return undefined;
    const int = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(int);
  }, [isActive]);

  const folder = settings.folderId !== undefined ? foldersById[settings.folderId] : undefined;
  const targetChatIds = useMemo(() => folder?.includedChatIds || [], [folder]);

  const loadStatusAndData = useLastCallback(async () => {
    try {
      const res = await fetchAutomationStatus();
      setStatusData(res);

      if (!isFormInitializedRef.current) {
        isFormInitializedRef.current = true;

        if (res.campaign) {
          setCampaign(res.campaign);
        }

        if (res.config) {
          setMode(res.config.mode || 'manual');
          setMinDelay(String(res.config.minDelaySeconds ?? 60));
          setMaxDelay(String(res.config.maxDelaySeconds ?? 180));
          setRoundInterval(String(res.config.roundIntervalMinutes ?? 120));
          setRoundTargetSends(String(res.config.roundTargetSends ?? 23));
          setMinOtherMsgs(String(res.config.minOtherMessages ?? 5));
          setMinResendInterval(String(res.config.minResendIntervalMinutes ?? 10));
          setSleepEnabled(Boolean(res.config.sleepWindowEnabled));
          setSleepStart(res.config.sleepWindowStart || '23:30');
          setSleepEnd(res.config.sleepWindowEnd || '07:30');
          setDailyLimit(String(res.config.dailyLimit ?? 80));
          setLinkPreview(Boolean(res.config.linkPreviewEnabled));
          setRotationEnabled(Boolean(res.config.templateRotationEnabled));
          setMicroPauseEnabled(res.config.microPauseEnabled !== undefined
            ? Boolean(res.config.microPauseEnabled) : true);
          setMicroPauseEveryMin(String(res.config.microPauseEveryMin ?? 6));
          setMicroPauseEveryMax(String(res.config.microPauseEveryMax ?? 10));
          setMicroPauseSeconds(String(res.config.microPauseSeconds ?? 300));
        }
      }

      if (activeTab === 'queue') {
        const groups = await fetchAutomationGroups();
        setGroupsData(groups);
      } else if (activeTab === 'logs') {
        const logs = await fetchAutomationLogs(50);
        setLogsData(logs);
      } else if (activeTab === 'debug') {
        const debug = await fetchAutomationDebug();
        setDebugData(debug);
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

      const serverNow = getServerTime();

      const targetChats = targetChatIds
        .map((id) => {
          const chat = chatsById[id];
          if (!chat) return undefined;

          const fullInfo = fullInfoById[id];
          const status = promoStatusById[id];
          const classification = classifyPromoChat(chat, fullInfo, status, serverNow);

          const slowmodeRemaining = getSlowmodeRemainingSeconds(fullInfo, status, serverNow);
          const slowmodeSeconds = fullInfo?.slowMode?.seconds || 0;
          const slowmodeNextSendDate = slowmodeRemaining > 0 ? (serverNow + slowmodeRemaining) : undefined;

          return {
            id,
            title: chat.title || `Chat ${id}`,
            accessHash: chat.accessHash,
            slowmodeSeconds,
            slowmodeNextSendDate,
            lastSentAt: status?.lastOwnMessageAt,
            starsCost: classification === 'stars' ? (chat.paidMessagesStars || 0) : 0,
            status: classification === 'blocked' ? ('BLOCKED' as const)
              : classification === 'stars' ? ('STARS' as const)
                : slowmodeRemaining > 0 ? ('WAITING_SLOWMODE' as const) : ('READY' as const),
          };
        })
        .filter((c): c is NonNullable<typeof c> => Boolean(c));

      if (!targetChats.length) {
        throw new Error(
          'A pasta selecionada não contém grupos. '
          + 'Grupos que cobram estrelas ou bloqueados ficam em quarentena e são revalidados automaticamente.',
        );
      }

      // 1. Handover session to backend — the browser is disconnected only after
      // the daemon confirms the takeover, so a backend failure never leaves the
      // UI without an active Telegram connection
      await startAutomationTakeover({
        sessionData,
        targetChats,
      });

      // 2. Disconnect browser client so the daemon owns the session exclusively
      await callApi('disconnect');

      // 3. Cover the whole app with the automation screen (no chat access while the daemon runs)
      const { activateAutomationMode } = getActions();
      activateAutomationMode();

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

      // 2. Reconnect browser client and leave the full-screen mode
      initApi();
      if (isEmbedded) {
        const { deactivateAutomationMode } = getActions();
        deactivateAutomationMode();
      }

      await loadStatusAndData();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const showSavedFeedback = useLastCallback(() => {
    setSaveSuccessMsg(lang('PromoAutomationSaved'));
    setTimeout(() => setSaveSuccessMsg(undefined), 3000);
  });

  const refreshCampaign = useLastCallback(async () => {
    setCampaign(await fetchAutomationCampaign());
  });

  const handleToggleRotation = useLastCallback(async (isEnabled: boolean) => {
    setRotationEnabled(isEnabled);
    try {
      await saveAutomationConfig({ templateRotationEnabled: isEnabled });
    } catch (err: any) {
      setRotationEnabled(!isEnabled);
      setActionError(err.message);
    }
  });

  const handleToggleLinkPreview = useLastCallback(async (isEnabled: boolean) => {
    setLinkPreview(isEnabled);
    try {
      await saveAutomationConfig({ linkPreviewEnabled: isEnabled });
    } catch (err: any) {
      setLinkPreview(!isEnabled);
      setActionError(err.message);
    }
  });

  const handleStartEditTemplate = useLastCallback((template?: AutomationCampaignTemplate) => {
    setEditingTemplate(template
      ? { id: template.id, title: template.title, content: template.content, weight: String(template.weight) }
      : { title: '', content: '', weight: '1' });
  });

  const handleCancelEditTemplate = useLastCallback(() => setEditingTemplate(undefined));

  const handleSaveTemplate = useLastCallback(async () => {
    if (!editingTemplate) return;

    const validation = validateSpintaxSyntax(editingTemplate.content);
    if (!validation.isValid) {
      setActionError(validation.error);
      return;
    }

    setActionError(undefined);
    markSubmitting();
    try {
      await saveCampaignTemplate({
        id: editingTemplate.id,
        title: editingTemplate.title.trim(),
        content: editingTemplate.content,
        weight: Math.max(1, Number(editingTemplate.weight) || 1),
      });
      setEditingTemplate(undefined);
      await refreshCampaign();
      showSavedFeedback();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const handleToggleTemplateEnabled = useLastCallback(
    async (template: AutomationCampaignTemplate, isEnabled: boolean) => {
      // Optimistic local toggle, reverted on failure
      const patchCampaign = (nextEnabled: boolean) => {
        setCampaign((current) => current && {
          ...current,
          templates: current.templates.map(
            (t) => (t.id === template.id ? { ...t, isEnabled: nextEnabled } : t),
          ),
        });
      };

      patchCampaign(isEnabled);
      try {
        await saveCampaignTemplate({
          id: template.id,
          title: template.title,
          content: template.content,
          weight: template.weight,
          isEnabled,
        });
      } catch (err: any) {
        patchCampaign(!isEnabled);
        setActionError(err.message);
      }
    },
  );

  const handleDeleteTemplate = useLastCallback(async (template: AutomationCampaignTemplate) => {
    if (!window.confirm(lang('PromoAutomationDeleteTemplateConfirm'))) return;
    setActionError(undefined);
    try {
      await deleteCampaignTemplate(template.id);
      await refreshCampaign();
    } catch (err: any) {
      setActionError(err.message);
    }
  });

  const handleToggleLinkEnabled = useLastCallback(
    async (link: AutomationCampaignLink, isEnabled: boolean) => {
      // Optimistic local toggle, reverted on failure
      const patchCampaign = (nextEnabled: boolean) => {
        setCampaign((current) => current && {
          ...current,
          allLinks: current.allLinks.map(
            (l) => (l.id === link.id ? { ...l, isEnabled: nextEnabled } : l),
          ),
        });
      };

      patchCampaign(isEnabled);
      try {
        await saveCampaignLink({ id: link.id, url: link.url, isEnabled });
      } catch (err: any) {
        patchCampaign(!isEnabled);
        setActionError(err.message);
      }
    },
  );

  const handleAddLink = useLastCallback(async () => {
    const url = newLinkUrl.trim();
    if (!url) return;

    setActionError(undefined);
    markSubmitting();
    try {
      await saveCampaignLink({ url });
      setNewLinkUrl('');
      await refreshCampaign();
      showSavedFeedback();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      unmarkSubmitting();
    }
  });

  const handleDeleteLink = useLastCallback(async (link: AutomationCampaignLink) => {
    setActionError(undefined);
    try {
      await deleteCampaignLink(link.id);
      await refreshCampaign();
    } catch (err: any) {
      setActionError(err.message);
    }
  });

  const handleCopyLink = useLastCallback((url: string) => {
    copyTextToClipboard(url);
    setCopiedUrl(url);
    setTimeout(() => setCopiedUrl(undefined), 1500);
  });

  const handleRerollPreview = useLastCallback(() => setPreviewSeed(Date.now()));

  const handleSkipPause = useLastCallback(async () => {
    setActionError(undefined);
    try {
      await skipAutomationPause();
      await loadStatusAndData();
    } catch (err: any) {
      setActionError(err.message);
    }
  });

  const handleForceNewRound = useLastCallback(async () => {
    setActionError(undefined);
    try {
      await forceNewAutomationRound();
      await loadStatusAndData();
    } catch (err: any) {
      setActionError(err.message);
    }
  });

  const handleReconnect = useLastCallback(async () => {
    setActionError(undefined);
    try {
      const res = await reconnectAutomationTelegram();
      setSaveSuccessMsg(res.message);
      setTimeout(() => setSaveSuccessMsg(undefined), 3000);
      await loadStatusAndData();
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
        roundTargetSends: Number(roundTargetSends) || 23,
        minOtherMessages: Number(minOtherMsgs) || 1,
        minResendIntervalMinutes: Number(minResendInterval) || 0,
        sleepWindowEnabled: sleepEnabled,
        sleepWindowStart: sleepStart,
        sleepWindowEnd: sleepEnd,
        dailyLimit: Number(dailyLimit) || 80,
        linkPreviewEnabled: linkPreview,
        microPauseEnabled,
        microPauseEveryMin: Number(microPauseEveryMin) || 6,
        microPauseEveryMax: Number(microPauseEveryMax) || 10,
        microPauseSeconds: Number(microPauseSeconds) || 300,
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

    const displayWaitUntil = statusData?.waitTotalUntil || statusData?.sleepUntil;
    const sleepRemaining = displayWaitUntil && displayWaitUntil > nowMs
      ? Math.ceil((displayWaitUntil - nowMs) / 1000)
      : 0;
    const nextRunRemaining = statusData?.nextRunAt && statusData.nextRunAt > nowMs
      ? Math.ceil((statusData.nextRunAt - nowMs) / 1000)
      : 0;

    let badgeClass = styles.badgeStopped;
    let label = lang('PromoAutomationStopped');

    if (status === 'RUNNING') {
      badgeClass = styles.badgeRunning;
      if (nextRunRemaining > 0 && statusData?.currentChatTitle) {
        label = `Enviando para ${statusData.currentChatTitle} em ${formatCountdownSeconds(nextRunRemaining)}`;
      } else {
        label = `${lang('PromoAutomationRunning')} (Rodada ${statusData?.activeRound || 1})`;
      }
    } else if (status === 'WAITING_COOLDOWN') {
      badgeClass = styles.badgeSleep;
      label = statusData?.waitingReason
        ? `${statusData.waitingReason} (${formatCountdownSeconds(sleepRemaining)})`
        : `Aguardando Cooldown (${formatCountdownSeconds(sleepRemaining)})`;
    } else if (status === 'WAITING_MESSAGES') {
      badgeClass = styles.badgeSleep;
      label = statusData?.waitingReason || 'Aguardando mensagens de terceiros';
    } else if (status === 'WAITING_NEXT_ROUND') {
      badgeClass = styles.badgeSleep;
      label = `Pausa entre Rodadas (${formatCountdownSeconds(sleepRemaining)})`;
    } else if (status === 'SLEEP_WINDOW') {
      badgeClass = styles.badgeSleep;
      label = sleepRemaining > 0
        ? `${lang('PromoAutomationSleepWindow')} (${formatCountdownSeconds(sleepRemaining)})`
        : lang('PromoAutomationSleepWindow');
    } else if (status === 'MICRO_PAUSE') {
      badgeClass = styles.badgeMicroPause;
      label = `${lang('PromoAutomationMicroPause')} (${formatCountdownSeconds(sleepRemaining)})`;
    } else if (status === 'CIRCUIT_BREAKER') {
      badgeClass = styles.badgeCircuit;
      label = `${lang('PromoAutomationCircuitBreaker')} (${formatCountdownSeconds(sleepRemaining)})`;
    }

    return (
      <div className={styles.statusBanner}>
        <div className={buildClassName(styles.statusBadge, badgeClass)}>
          <span className={styles.statusDot} />
          <span>{label}</span>
        </div>
        <div className={styles.controls}>
          {isRunning
            && (
              status === 'MICRO_PAUSE'
              || status === 'WAITING_NEXT_ROUND'
              || status === 'CIRCUIT_BREAKER'
            ) && (
            <Button
              color="translucent"
              size="smaller"
              onClick={handleSkipPause}
            >
              {lang('PromoAutomationSkipPause')}
            </Button>
          )}
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
            {statusData.sentInRoundCount || 0}
            {' / '}
            {statusData.config.roundTargetSends ?? 23}
          </div>
          <div className={styles.statLabel}>Enviados na Rodada</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue}>
            {stats.todaySent}
            {' / '}
            {stats.dailyLimit}
          </div>
          <div className={styles.statLabel}>Últimas 24h</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue}>{stats.readyCount}</div>
          <div className={styles.statLabel}>Prontos</div>
        </div>
        <div className={styles.statCard}>
          <div className={styles.statValue}>
            {stats.waitingMessagesCount}
            {' msgs / '}
            {stats.waitingSlowmodeCount}
            {' slow'}
          </div>
          <div className={styles.statLabel}>Aguardando</div>
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
        <button
          type="button"
          className={buildClassName(styles.tabBtn, activeTab === 'debug' && styles.tabBtnActive)}
          onClick={() => setActiveTab('debug')}
        >
          {lang('PromoAutomationDebugTab')}
        </button>
      </div>
    );
  };

  const enabledLinks = useMemo(
    () => (campaign?.allLinks ?? []).filter((l) => l.isEnabled).map((l) => l.url),
    [campaign],
  );

  const savedPreview = useMemo(() => {
    // previewSeed forces a fresh random pick on re-roll
    const seed = previewSeed;
    const template = pickTemplate(campaign?.templates ?? [], rotationEnabled);
    return { seed, template };
  }, [campaign, rotationEnabled, previewSeed]);

  // While editing, the preview follows the draft content live
  const previewContent = editingTemplate ? editingTemplate.content : savedPreview.template?.content;

  const previewMessage = useMemo(() => {
    if (previewContent === undefined) return undefined;
    return compileSpunMessage(previewContent, enabledLinks).messageText;
  }, [previewContent, enabledLinks]);

  const previewVariations = previewContent !== undefined
    ? countMessageVariations(previewContent, enabledLinks) : 0;
  const isLowVariety = previewVariations > 0 && previewVariations < MIN_HEALTHY_VARIATIONS;

  const renderCampaignTab = () => {
    const templates = campaign?.templates ?? [];
    const links = campaign?.allLinks ?? [];
    const editingValidation = editingTemplate
      ? validateSpintaxSyntax(editingTemplate.content) : undefined;

    return (
      <div className={styles.tabContent}>
        <div className={styles.sectionGroup}>
          <div className={styles.sectionHeader}>
            <span className={styles.fieldLabel}>{lang('PromoAutomationPreviewTitle')}</span>
            {previewVariations > 0 && (
              <span
                className={buildClassName(
                  styles.variationsBadge,
                  isLowVariety && styles.variationsLow,
                )}
                title={lang('PromoAutomationVariationsHint')}
              >
                {lang(
                  'PromoAutomationVariations',
                  { count: previewVariations },
                  { pluralValue: previewVariations },
                )}
              </span>
            )}
          </div>
          {previewMessage !== undefined ? (
            <>
              <div className={styles.previewBubble}>{previewMessage}</div>
              <div className={styles.btnRow}>
                <Button size="smaller" color="translucent" onClick={handleRerollPreview}>
                  {lang('PromoAutomationReroll')}
                </Button>
              </div>
              {isLowVariety && (
                <div className={styles.varietyWarning}>{lang('PromoAutomationVarietyLow')}</div>
              )}
            </>
          ) : (
            <div className={styles.emptyText}>{lang('PromoAutomationNoTemplates')}</div>
          )}
        </div>

        <div className={styles.checkboxRow}>
          <Checkbox
            checked={linkPreview}
            onCheck={handleToggleLinkPreview}
            label={lang('PromoAutomationLinkPreview')}
          />
        </div>
        <div className={styles.checkboxRow}>
          <Checkbox
            checked={rotationEnabled}
            onCheck={handleToggleRotation}
            label={lang('PromoAutomationRotationLabel')}
          />
        </div>

        <div className={styles.sectionGroup}>
          <div className={styles.sectionHeader}>
            <span className={styles.fieldLabel}>{lang('PromoAutomationTemplatesLabel')}</span>
            {!editingTemplate && (
              <Button size="smaller" color="translucent" onClick={() => handleStartEditTemplate()}>
                {lang('PromoAutomationNewTemplate')}
              </Button>
            )}
          </div>

          {editingTemplate && (
            <div className={styles.templateEdit}>
              <InputText
                label={lang('PromoAutomationTemplateTitle')}
                value={editingTemplate.title}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setEditingTemplate({
                  ...editingTemplate,
                  title: e.target.value,
                })}
              />
              <textarea
                className={styles.textarea}
                rows={5}
                value={editingTemplate.content}
                placeholder="{Olá|Oi|E aí} pessoal, confiram {esse link|essa novidade}: {LINK}"
                onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setEditingTemplate({
                  ...editingTemplate,
                  content: e.target.value,
                })}
              />
              <div className={styles.twoCols}>
                <InputText
                  label={lang('PromoAutomationTemplateWeight')}
                  value={editingTemplate.weight}
                  inputMode="numeric"
                  onChange={(e: ChangeEvent<HTMLInputElement>) => setEditingTemplate({
                    ...editingTemplate,
                    weight: e.target.value,
                  })}
                />
                <div className={styles.btnRow}>
                  <Button size="smaller" onClick={handleCancelEditTemplate}>
                    {lang('PromoAutomationCancel')}
                  </Button>
                  <Button
                    size="smaller"
                    color="primary"
                    disabled={isSubmitting || !editingValidation?.isValid}
                    onClick={handleSaveTemplate}
                  >
                    {lang('PromoAutomationSave')}
                  </Button>
                </div>
              </div>
              {editingTemplate.content && !editingValidation?.isValid && (
                <div className={styles.inlineError}>{editingValidation?.error}</div>
              )}
            </div>
          )}

          {templates.filter((t) => t.id !== editingTemplate?.id).map((template) => {
            const templateVariations = countMessageVariations(template.content, enabledLinks);
            return (
              <div
                key={template.id}
                className={buildClassName(
                  styles.templateCard,
                  !template.isEnabled && styles.templateCardOff,
                )}
              >
                <div className={styles.templateHead}>
                  <Checkbox
                    checked={template.isEnabled}
                    onCheck={(isEnabled) => handleToggleTemplateEnabled(template, isEnabled)}
                  />
                  <div className={styles.templateInfo}>
                    <div className={styles.templateTitle}>
                      {template.title || lang('PromoAutomationUntitledTemplate')}
                    </div>
                    <div className={styles.templateSnippet}>{template.content}</div>
                  </div>
                  <span
                    className={styles.templateVariations}
                    title={lang('PromoAutomationVariationsHint')}
                  >
                    {lang(
                      'PromoAutomationVariations',
                      { count: templateVariations },
                      { pluralValue: templateVariations },
                    )}
                  </span>
                  <span
                    className={styles.templateWeight}
                    title={lang('PromoAutomationTemplateWeight')}
                  >
                    ×
                    {template.weight}
                  </span>
                  <div className={styles.linkActions}>
                    <Button
                      round
                      size="smaller"
                      color="translucent"
                      ariaLabel={lang('PromoAutomationEdit')}
                      iconName="edit"
                      onClick={() => handleStartEditTemplate(template)}
                    />
                    <Button
                      round
                      size="smaller"
                      color="translucent"
                      ariaLabel={lang('PromoAutomationDelete')}
                      iconName="delete"
                      onClick={() => handleDeleteTemplate(template)}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className={styles.sectionGroup}>
          <div className={styles.sectionHeader}>
            <span className={styles.fieldLabel}>{lang('PromoAutomationLinksLabel')}</span>
          </div>
          {!links.length && (
            <div className={styles.emptyText}>{lang('PromoAutomationNoLinks')}</div>
          )}
          {links.map((link) => (
            <div
              key={link.id}
              className={buildClassName(
                styles.linkItem,
                !link.isEnabled && styles.linkItemOff,
              )}
            >
              <Checkbox
                checked={link.isEnabled}
                onCheck={(isEnabled) => handleToggleLinkEnabled(link, isEnabled)}
              />
              <span className={styles.linkUrl}>{link.url}</span>
              {copiedUrl === link.url && (
                <span className={styles.linkCopiedHint}>{lang('PromoAutomationLinkCopied')}</span>
              )}
              <div className={styles.linkActions}>
                <Button
                  round
                  size="smaller"
                  color="translucent"
                  ariaLabel={lang('PromoAutomationCopyLink')}
                  iconName="copy"
                  onClick={() => handleCopyLink(link.url)}
                />
                <Button
                  round
                  size="smaller"
                  color="translucent"
                  ariaLabel={lang('PromoAutomationDelete')}
                  iconName="delete"
                  onClick={() => handleDeleteLink(link)}
                />
              </div>
            </div>
          ))}
          <div className={styles.addLinkRow}>
            <InputText
              placeholder={lang('PromoAutomationLinkUrlPlaceholder')}
              value={newLinkUrl}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setNewLinkUrl(e.target.value)}
            />
            <Button
              size="smaller"
              disabled={isSubmitting || !newLinkUrl.trim()}
              onClick={handleAddLink}
            >
              {lang('PromoAutomationAddLink')}
            </Button>
          </div>
        </div>
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
          label={lang('PromoAutomationRoundTargetSends')}
          value={roundTargetSends}
          inputMode="numeric"
          onChange={(e) => setRoundTargetSends(e.target.value)}
        />

        <InputText
          label={lang('PromoAutomationMinOtherMessages')}
          value={minOtherMsgs}
          inputMode="numeric"
          onChange={(e) => setMinOtherMsgs(e.target.value)}
        />

        <InputText
          label={lang('PromoAutomationMinResendInterval')}
          value={minResendInterval}
          inputMode="numeric"
          onChange={(e) => setMinResendInterval(e.target.value)}
        />

        <InputText
          label={lang('PromoAutomationDailyLimit')}
          value={dailyLimit}
          inputMode="numeric"
          onChange={(e) => setDailyLimit(e.target.value)}
        />

        <div className={styles.checkboxRow}>
          <Checkbox
            checked={microPauseEnabled}
            onCheck={setMicroPauseEnabled}
            label={lang('PromoAutomationMicroPauseToggle')}
          />
        </div>

        {microPauseEnabled && (
          <div className={styles.twoCols}>
            <InputText
              label={lang('PromoAutomationMicroPauseMin')}
              value={microPauseEveryMin}
              inputMode="numeric"
              onChange={(e) => setMicroPauseEveryMin(e.target.value)}
            />
            <InputText
              label={lang('PromoAutomationMicroPauseMax')}
              value={microPauseEveryMax}
              inputMode="numeric"
              onChange={(e) => setMicroPauseEveryMax(e.target.value)}
            />
            <InputText
              label={lang('PromoAutomationMicroPauseDuration')}
              value={microPauseSeconds}
              inputMode="numeric"
              onChange={(e) => setMicroPauseSeconds(e.target.value)}
            />
          </div>
        )}

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
                  {g.lastSentAt ? `Enviado ${new Date(g.lastSentAt * 1000).toLocaleTimeString()} · ` : 'Nunca · '}
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
                g.status === 'STARS' && styles.queueBlocked,
                g.status === 'SENT' && styles.queueReady,
              )}
              >
                {g.status === 'STARS' ? 'COBRA ESTRELAS' : g.status}
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
          logsData.map((log, idx) => {
            const logDate = new Date(log.createdAt * 1000);
            return (
              <div key={idx} className={styles.logRow}>
                <div className={styles.logTop}>
                  <span className={styles.logTitle}>{log.chatTitle}</span>
                  <div className={styles.logMeta}>
                    <span
                      className={styles.logTime}
                      title={logDate.toLocaleString(lang.code)}
                    >
                      {logDate.toLocaleTimeString(lang.code)}
                    </span>
                    <span className={buildClassName(
                      styles.logStatus,
                      log.status === 'SUCCESS' && styles.logSuccess,
                      log.status === 'SKIPPED' && styles.logSkipped,
                      log.status === 'FLOOD_WAIT' && styles.logFlood,
                      log.status === 'ERROR' && styles.logError,
                    )}
                    >
                      {log.status}
                    </span>
                  </div>
                </div>
                <div className={styles.logSnippet}>{log.messageSnippet}</div>
                {log.details && <div className={styles.logDetails}>{log.details}</div>}
              </div>
            );
          })
        )}
      </div>
    );
  };

  const renderDebugTab = () => {
    if (!debugData) {
      return (
        <div className={styles.loadingWrap}>
          <Spinner />
        </div>
      );
    }

    const { scheduler, connection, groups: debugGroups, system } = debugData;

    return (
      <div className={styles.tabContent}>
        <div className={styles.debugCard}>
          <div className={styles.debugTitle}>Telemetria do Agendador (Scheduler)</div>
          <div className={styles.debugRow}>
            <span>Status:</span>
            <span className={styles.debugVal}>{scheduler?.status}</span>
          </div>
          <div className={styles.debugRow}>
            <span>Rodada Atual:</span>
            <span className={styles.debugVal}>
              #
              {scheduler?.activeRound}
            </span>
          </div>
          <div className={styles.debugRow}>
            <span>Envios Consecutivos no Lote:</span>
            <span className={styles.debugVal}>{scheduler?.consecutiveSendsInRun}</span>
          </div>
          {Boolean(scheduler?.sleepRemainingSeconds) && (
            <div className={styles.debugRow}>
              <span>Tempo de Pausa Restante:</span>
              <span className={styles.debugVal}>
                {formatCountdownSeconds(scheduler.sleepRemainingSeconds)}
                {' ('}
                {scheduler.sleepRemainingSeconds}
                s)
              </span>
            </div>
          )}
          {Boolean(scheduler?.nextRunRemainingSeconds) && (
            <div className={styles.debugRow}>
              <span>Próximo Disparo em:</span>
              <span className={styles.debugVal}>
                {formatCountdownSeconds(scheduler.nextRunRemainingSeconds)}
                {' ('}
                {scheduler.nextRunRemainingSeconds}
                s)
              </span>
            </div>
          )}
          {scheduler?.lastRunError && (
            <div className={styles.debugRow}>
              <span>Último Erro:</span>
              <span className={buildClassName(styles.debugVal, styles.logError)}>
                {scheduler.lastRunError}
              </span>
            </div>
          )}
          {isRunning && (
            <div className={styles.btnRow}>
              {Boolean(scheduler?.sleepRemainingSeconds) && (
                <Button size="smaller" color="translucent" onClick={handleSkipPause}>
                  {lang('PromoAutomationSkipPause')}
                </Button>
              )}
              <Button size="smaller" color="primary" onClick={handleForceNewRound}>
                Forçar Nova Rodada
              </Button>
            </div>
          )}
        </div>

        <div className={styles.debugCard}>
          <div className={styles.debugTitle}>Conexão Telegram (Daemon MTProto)</div>
          <div className={styles.debugRow}>
            <span>Status da Conexão:</span>
            <span className={styles.debugVal}>
              {connection?.isConnected ? '🟢 CONECTADO (Online)' : '🔴 DESCONECTADO (Offline)'}
            </span>
          </div>
          <div className={styles.debugRow}>
            <span>Total Updates Recebidos:</span>
            <span className={styles.debugVal}>{connection?.totalUpdatesReceived || 0}</span>
          </div>
          <div className={styles.debugRow}>
            <span>Último Update Recebido:</span>
            <span className={styles.debugVal}>
              {connection?.lastUpdateReceivedAt
                ? new Date(connection.lastUpdateReceivedAt).toLocaleTimeString()
                : 'Nenhum ainda'}
            </span>
          </div>
          <div className={styles.debugRow}>
            <span>Proxy Configurado:</span>
            <span className={styles.debugVal}>{system?.isProxyConfigured ? 'SIM' : 'NÃO (Conexão Direta)'}</span>
          </div>
          <div className={styles.btnRow}>
            <Button size="smaller" color="translucent" onClick={handleReconnect}>
              Reconectar Telegram
            </Button>
          </div>
        </div>

        <div className={styles.debugCard}>
          <div className={styles.debugTitle}>
            Diagnóstico dos Grupos (
            {debugGroups?.length || 0}
            )
          </div>
          {debugGroups?.map((g: any) => (
            <div key={g.chatId} className={styles.debugGroupRow}>
              <div className={styles.debugGroupName}>{g.title}</div>
              <div className={styles.debugGroupDetails}>
                <span>
                  Status:
                  {' '}
                  <strong>{g.evaluatedReason}</strong>
                </span>
                <span>
                  Msgs:
                  {' '}
                  {g.otherMessagesCount}
                  /
                  {g.minOtherMessagesRequired}
                </span>
                {g.slowmodeRemaining > 0 && (
                  <span>
                    Slowmode:
                    {' '}
                    {g.slowmodeRemaining}
                    s
                  </span>
                )}
                {g.starsCost > 0 && (
                  <span className={styles.logError}>
                    Estrelas:
                    {' '}
                    {g.starsCost}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

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
            {activeTab === 'debug' && renderDebugTab()}
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
      fullInfoById: global.chats.fullInfoById,
      promoStatusById: selectPromoUserState(global).statusById,
    };
  },
)(PromoAutomation));
