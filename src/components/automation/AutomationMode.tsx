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

const AutomationMode = ({ showIntroTransition }: StateProps) => {
  const { consumeAutomationIntroTransition, deactivateAutomationMode, initApi } = getActions();

  const [activePane, setActivePane] = useState<AutomationPane>('automation');
  const [introStep, setIntroStep] = useState<IntroStep>(showIntroTransition ? 'takeover' : 'done');
  const [isDaemonFailed, markDaemonFailed, unmarkDaemonFailed] = useFlag();
  const [isRecovering, startRecovering, stopRecovering] = useFlag();
  const [failedAt, setFailedAt] = useState<string>();

  const statusRef = useRef<AutomationStatusResponse>();
  const failStreakRef = useRef(0);

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

  const handleReconnect = useLastCallback(async () => {
    startRecovering();
    try {
      const sessionData = loadStoredSession();
      if (!sessionData) throw new Error('Sessão local não encontrada');

      // Empty targetChats lets the daemon reuse the saved group rotation
      await startAutomationTakeover({ sessionData, targetChats: [] });
      unmarkDaemonFailed();
    } catch {
      // Keep the failure panel up — user can retry or leave
    } finally {
      stopRecovering();
    }
  });

  const handleBackToChat = useLastCallback(async () => {
    startRecovering();
    try {
      await stopAutomationRelease();
    } catch {
      // Daemon may be gone entirely; still leave the mode
    }
    deactivateAutomationMode();
    initApi();
    stopRecovering();
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
          </p>
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
