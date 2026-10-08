import {
  memo, useEffect, useRef, useState,
} from '../../lib/teact/teact';
import { getActions, withGlobal } from '../../global';

import type { AutomationStatusResponse } from '../../util/promo/automationApi';

import buildClassName from '../../util/buildClassName';
import {
  fetchAutomationStatus,
  startAutomationTakeover,
  stopAutomationRelease,
} from '../../util/promo/automationApi';
import { loadStoredSession } from '../../util/sessions';
import { callApi } from '../../api/gramjs';

import useFlag from '../../hooks/useFlag';
import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Icon from '../common/icons/Icon';
import PromoAutomation from '../left/promo/PromoAutomation';
import PromoExtract from '../left/promo/PromoExtract';
import PromoOrchestration from '../left/promo/PromoOrchestration';
import Button from '../ui/Button';
import Spinner from '../ui/Spinner';

import styles from './AutomationMode.module.scss';

type StateProps = {
  showIntroTransition?: boolean;
};

type AutomationPane = 'automation' | 'extract' | 'orchestration';

type IntroStep = 'takeover' | 'daemon' | 'disconnect' | 'done';

const INTRO_STEPS: {
  key: IntroStep;
  langKey: 'AutomationModeStepTakeover' | 'AutomationModeStepDaemon'
    | 'AutomationModeStepDisconnect' | 'AutomationModeStepDone';
}[] = [
  { key: 'takeover', langKey: 'AutomationModeStepTakeover' },
  { key: 'daemon', langKey: 'AutomationModeStepDaemon' },
  { key: 'disconnect', langKey: 'AutomationModeStepDisconnect' },
  { key: 'done', langKey: 'AutomationModeStepDone' },
];
const INTRO_STEP_MS = 650;
const POLL_INTERVAL_MS = 10_000;
const POLL_FAILURE_THRESHOLD = 3;
// Same window the daemon enforces: when the daemon dies holding a connected
// session, the Telegram server can keep the auth key "in use" for a while
// (proxies hold the upstream even longer) — reconnecting inside that window
// triggers AUTH_KEY_DUPLICATED and destroys the session (postmortem 72)
const SESSION_RECONNECT_COOLDOWN_MS = 180_000;

const AutomationMode = ({ showIntroTransition }: StateProps) => {
  const { consumeAutomationIntroTransition, deactivateAutomationMode, initApi } = getActions();

  const [activePane, setActivePane] = useState<AutomationPane>('automation');
  const [introStep, setIntroStep] = useState<IntroStep>(showIntroTransition ? 'takeover' : 'done');
  const [isDaemonFailed, markDaemonFailed, unmarkDaemonFailed] = useFlag();
  const [isRecovering, startRecovering, stopRecovering] = useFlag();
  const [isPendingBack, markPendingBack, unmarkPendingBack] = useFlag();
  const [failedAt, setFailedAt] = useState<string>();
  const [sessionWaitSeconds, setSessionWaitSeconds] = useState<number>();
  const [reconnectError, setReconnectError] = useState<string>();

  const statusRef = useRef<AutomationStatusResponse>();
  const failStreakRef = useRef(0);
  const lastConnectedSeenAtRef = useRef<number>();

  const lang = useLang();

  // Browser back inside the mode only navigates between panes; leaving
  // requires the explicit release flow (keeps session ownership strict)
  useHistoryBack({
    isActive: activePane !== 'automation',
    onBack: () => setActivePane('automation'),
  });

  // Failsafe for the intro: never leaves the sequence hanging forever
  useEffect(() => {
    if (introStep === 'done') return undefined;

    const timers: number[] = [];
    const stepIndex = INTRO_STEPS.findIndex((step) => step.key === introStep);
    if (stepIndex < INTRO_STEPS.length - 1) {
      timers.push(window.setTimeout(() => {
        setIntroStep(INTRO_STEPS[stepIndex + 1].key);
      }, INTRO_STEP_MS));
    } else {
      consumeAutomationIntroTransition();
    }

    return () => timers.forEach(window.clearTimeout);
  }, [introStep]);

  const pollStatus = useLastCallback(async () => {
    try {
      const status = await fetchAutomationStatus();
      statusRef.current = status;
      if (status.isTelegramConnected) {
        lastConnectedSeenAtRef.current = Date.now();
      }
      failStreakRef.current = 0;
      unmarkDaemonFailed();
    } catch {
      failStreakRef.current += 1;
      if (failStreakRef.current >= POLL_FAILURE_THRESHOLD) {
        setFailedAt(new Date().toLocaleTimeString(lang.code));
        markDaemonFailed();
      }
    }
  });

  useEffect(() => {
    void pollStatus();
    const interval = window.setInterval(() => {
      if (introStep === 'done') {
        void pollStatus();
      }
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [introStep]);

  // Remaining seconds the session key is unsafe to use: trust the daemon's
  // own cooldown while it is reachable; when it is gone entirely, count the
  // same window from the last poll that saw the session connected — the
  // daemon died holding it
  const fetchSessionWaitSeconds = useLastCallback(async (): Promise<number> => {
    try {
      const status = await fetchAutomationStatus();
      statusRef.current = status;
      if (status.isTelegramConnected) {
        lastConnectedSeenAtRef.current = Date.now();
        return 0;
      }
      return status.sessionSafetyWaitSeconds || 0;
    } catch {
      const lastConnectedSeenAt = lastConnectedSeenAtRef.current;
      if (!lastConnectedSeenAt) return 0;
      const elapsedMs = Date.now() - lastConnectedSeenAt;
      return Math.max(0, Math.ceil((SESSION_RECONNECT_COOLDOWN_MS - elapsedMs) / 1000));
    }
  });

  // While the exit is parked waiting out the reconnect cooldown, keep the
  // countdown moving locally and hand back to the chat the moment the
  // session key is safe again
  useEffect(() => {
    if (!isPendingBack) return undefined;
    const fetchTimer = window.setInterval(() => {
      void fetchSessionWaitSeconds().then((waitSeconds) => {
        setSessionWaitSeconds(waitSeconds);
        if (waitSeconds > 0) return;
        unmarkPendingBack();
        deactivateAutomationMode();
        initApi();
      });
    }, POLL_INTERVAL_MS);
    const displayTimer = window.setInterval(() => {
      setSessionWaitSeconds((current) => (current && current > 0 ? current - 1 : current));
    }, 1000);
    return () => {
      window.clearInterval(fetchTimer);
      window.clearInterval(displayTimer);
    };
  }, [isPendingBack]);

  const handleReconnect = useLastCallback(async () => {
    startRecovering();
    try {
      const sessionData = loadStoredSession();
      if (!sessionData) throw new Error('Sessão local não encontrada');

      // Empty targetChats lets the daemon reuse the saved group rotation
      await startAutomationTakeover({ sessionData, targetChats: [] });
      unmarkDaemonFailed();
      setReconnectError(undefined);
      // After a re-login the browser client may own the session — hand it
      // to the daemon exactly like the panel start does; the takeover went
      // through as a coordinated handover
      try {
        await callApi('disconnect');
      } catch {
        // The daemon owns the session now; a failed browser disconnect is
        // retried by the presence watcher
      }
    } catch (err: any) {
      // Keep the failure panel up and show why the retry did not take
      setReconnectError(err.message);
    } finally {
      stopRecovering();
    }
  });

  const handleBackToChat = useLastCallback(async () => {
    startRecovering();
    try {
      await stopAutomationRelease();
    } catch {
      // Daemon may be gone entirely; the cooldown below guards the exit
    }
    const waitSeconds = await fetchSessionWaitSeconds();
    stopRecovering();
    if (waitSeconds > 0) {
      // Reconnecting now could destroy the session (AUTH_KEY_DUPLICATED) —
      // park the exit until the Telegram server releases the key
      setReconnectError(undefined);
      setSessionWaitSeconds(waitSeconds);
      markPendingBack();
      return;
    }
    unmarkPendingBack();
    deactivateAutomationMode();
    initApi();
  });

  if (isDaemonFailed) {
    return (
      <div className={buildClassName(styles.root, styles.introRoot)}>
        <div className={styles.failureCard}>
          <Icon name="close" />
          <h3>{lang('AutomationModeLostTitle')}</h3>
          <p className={styles.failureText}>
            {lang('AutomationModeLostText')}
            {failedAt && ` (${failedAt})`}
            {statusRef.current?.lastError && (
              <>
                <br />
                <code>{statusRef.current.lastError}</code>
              </>
            )}
            {reconnectError && (
              <>
                <br />
                <code>{reconnectError}</code>
              </>
            )}
          </p>
          {isPendingBack && (
            <p className={styles.failureText}>
              {lang('AutomationModeSessionWait', { seconds: sessionWaitSeconds || 0 })}
            </p>
          )}
          <div className={styles.failureActions}>
            <Button
              color="primary"
              isLoading={isRecovering}
              onClick={handleReconnect}
            >
              {lang('AutomationModeReconnect')}
            </Button>
            <Button
              color="translucent"
              disabled={isRecovering}
              onClick={handleBackToChat}
            >
              {lang('AutomationModeBackToChat')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      {introStep !== 'done' && (
        <div className={styles.introOverlay}>
          <div className={styles.introSteps}>
            {INTRO_STEPS.map((step, i) => {
              const currentIndex = INTRO_STEPS.findIndex((entry) => entry.key === introStep);
              const stepState = i < currentIndex ? 'done' : i === currentIndex ? 'active' : 'pending';
              return (
                <div
                  key={step.key}
                  className={buildClassName(
                    styles.introStep,
                    stepState === 'done' && styles.introStepDone,
                    stepState === 'active' && styles.introStepActive,
                  )}
                >
                  <span className={styles.introStepIcon}>
                    {stepState === 'done' && <Icon name="check" />}
                    {stepState === 'active' && <Spinner color="white" />}
                  </span>
                  <span>{lang(step.langKey)}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className={styles.topbar}>
        <div className={styles.topbarTitle}>
          <Icon name="bots" />
          <h3>{lang('AutomationModeTitle')}</h3>
        </div>
        <nav className={styles.tabsNav}>
          {(['automation', 'extract', 'orchestration'] as AutomationPane[]).map((pane) => (
            <button
              key={pane}
              className={buildClassName(styles.tabNavButton, activePane === pane && styles.tabNavActive)}
              onClick={() => setActivePane(pane)}
            >
              {pane === 'automation' && lang('PromoAutomationTitle')}
              {pane === 'extract' && lang('PromoExtractTitle')}
              {pane === 'orchestration' && lang('PromoOrchestrationTitle')}
            </button>
          ))}
        </nav>
      </div>

      {isPendingBack && (
        <div className={styles.sessionWaitBanner}>
          {lang('AutomationModeSessionWait', { seconds: sessionWaitSeconds || 0 })}
        </div>
      )}

      <div className={styles.content}>
        {activePane === 'automation' && (
          <PromoAutomation isActive isEmbedded onReset={handleBackToChat} />
        )}
        {activePane === 'extract' && (
          <PromoExtract isActive isEmbedded onReset={() => setActivePane('automation')} />
        )}
        {activePane === 'orchestration' && (
          <PromoOrchestration isActive isEmbedded onReset={() => setActivePane('automation')} />
        )}
      </div>
    </div>
  );
};

export default memo(withGlobal(
  (global): Complete<StateProps> => {
    return {
      showIntroTransition: global.automationMode.showIntroTransition,
    };
  },
)(AutomationMode));
