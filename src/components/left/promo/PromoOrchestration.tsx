import type { ChangeEvent } from 'react';
import {
  memo,
  useEffect,
  useState,
} from '../../../lib/teact/teact';

import type { LangFn } from '../../../util/localization/types';

import buildClassName from '../../../util/buildClassName';
import {
  buildCampaignCopyPayload,
  fetchAutomationCampaign,
  fetchOrchestratorGrants,
  fetchOrchestratorInfo,
  fetchOrchestratorOverrides,
  fetchOrchestratorWorkers,
  type OrchestratorAccountInfo,
  type OrchestratorConfigDigest,
  type OrchestratorGrant,
  type OrchestratorInfo,
  type OrchestratorOverrides,
  type OrchestratorOverrideValue,
  type OrchestratorWorker,
  sendOrchestratorCommand,
  updateOrchestratorOverrides,
} from '../../../util/promo/automationApi';
import { formatCountdownSeconds } from '../../../util/promo/countdownFormat';
import {
  formatOverrideValue,
  getOverrideFieldLabel,
  OVERRIDE_FIELD_IDS,
  OVERRIDEABLE_FIELDS,
} from '../../../util/promo/orchestratorFields';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';

import styles from './PromoOrchestration.module.scss';

type OwnProps = {
  isActive: boolean;
  // Rendered inside the full-screen AutomationMode (no back button)
  isEmbedded?: boolean;
  onReset: () => void;
};

const REFRESH_INTERVAL_MS = 5000;
const TIME_FORMAT_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_OVERRIDE_VALUE_BY_TYPE: Record<string, string> = {
  number: '60',
  time: '23:30',
  boolean: 'true',
  mode: 'manual',
};
const COMMAND_LABEL_KEYS = {
  start: 'PromoOrchestrationCommandStart',
  stop: 'PromoOrchestrationCommandStop',
  'campaign-copy': 'PromoOrchestrationCommandCopy',
} as const;

function formatAccountLabel(account: OrchestratorAccountInfo | undefined): string | undefined {
  if (!account) return undefined;
  if (account.username) return `@${account.username}`;
  if (account.firstName) return account.firstName;
  return account.userId;
}

function getAccountTitle(account: OrchestratorAccountInfo | undefined): string | undefined {
  if (!account) return undefined;
  return account.username ? `@${account.username} · ${account.userId}` : account.userId;
}

// Read-only digest of the effective rhythm so accounts can be compared without
// opening each one's settings
function buildDigestChips(digest: OrchestratorConfigDigest, lang: LangFn) {
  const chips: string[] = [
    digest.mode === 'continuous'
      ? lang('PromoAutomationModeContinuous')
      : lang('PromoAutomationModeManual'),
    lang('PromoOrchestrationDigestDelay', { min: digest.minDelaySeconds, max: digest.maxDelaySeconds }),
    lang('PromoOrchestrationDigestTarget', { count: digest.roundTargetSends }),
    lang('PromoOrchestrationDigestMinOther', { count: digest.minOtherMessages }),
    lang('PromoOrchestrationDigestDaily', { count: digest.dailyLimit }),
  ];
  if (digest.mode === 'continuous') {
    chips.splice(
      2,
      0,
      lang('PromoOrchestrationDigestRound', { minutes: digest.roundIntervalMinutes }),
    );
  }
  if (digest.minResendIntervalMinutes > 0) {
    chips.push(lang('PromoOrchestrationDigestResend', { count: digest.minResendIntervalMinutes }));
  }
  if (digest.sleepWindowEnabled) {
    chips.push(lang('PromoOrchestrationDigestSleep', {
      start: digest.sleepWindowStart,
      end: digest.sleepWindowEnd,
    }));
  }
  return chips.map((chip) => (
    <span key={chip} className={styles.digestChip}>{chip}</span>
  ));
}

const PromoOrchestration = ({ isActive, isEmbedded, onReset }: OwnProps) => {
  const [info, setInfo] = useState<OrchestratorInfo>();
  const [workers, setWorkers] = useState<OrchestratorWorker[]>([]);
  const [grants, setGrants] = useState<OrchestratorGrant[]>([]);
  const [overrides, setOverrides] = useState<OrchestratorOverrides>({});
  const [loaderTarget, setLoaderTarget] = useState(0);
  const [loadError, setLoadError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [isCommandBusy, setIsCommandBusy] = useState(false);
  const [isOverridesBusy, setIsOverridesBusy] = useState(false);
  const [overrideField, setOverrideField] = useState('minDelaySeconds');
  const [overrideValueText, setOverrideValueText] = useState(
    DEFAULT_OVERRIDE_VALUE_BY_TYPE[OVERRIDEABLE_FIELDS.minDelaySeconds.type],
  );

  useHistoryBack({
    // Embedded in AutomationMode: navigation/history is owned by the parent shell
    isActive: isActive && !isEmbedded,
    onBack: onReset,
  });

  const lang = useLang();

  useEffect(() => {
    if (!isActive) return undefined;

    let isCancelled = false;

    const load = async () => {
      try {
        const [nextInfo, nextWorkers, nextGrants, nextOverrides] = await Promise.all([
          fetchOrchestratorInfo(),
          fetchOrchestratorWorkers(),
          fetchOrchestratorGrants(50),
          fetchOrchestratorOverrides(),
        ]);
        if (isCancelled) return;
        setInfo(nextInfo);
        setWorkers(nextWorkers);
        setGrants(nextGrants);
        setOverrides(nextOverrides.overrides);
        setLoadError(undefined);
      } catch (err: any) {
        if (!isCancelled) setLoadError(err.message);
      }
    };

    load();
    const interval = window.setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      isCancelled = true;
      window.clearInterval(interval);
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return undefined;
    const interval = window.setInterval(() => {
      setLoaderTarget(Date.now());
    }, 1000);
    return () => window.clearInterval(interval);
  }, [isActive]);

  const handleStartWorker = useLastCallback(async (worker: OrchestratorWorker) => {
    const label = formatAccountLabel(worker.statusSnapshot?.account) || worker.workerId;
    // One conscious click per account: no batching, no auto-retry
    if (!window.confirm(lang('PromoOrchestrationStartConfirm', { account: label }))) return;
    setIsCommandBusy(true);
    try {
      await sendOrchestratorCommand(worker.workerId, 'start');
      setActionError(undefined);
    } catch (err: any) {
      setActionError(lang('PromoOrchestrationCommandError', { error: err.message }));
    } finally {
      setIsCommandBusy(false);
    }
  });

  const handleStopWorker = useLastCallback(async (worker: OrchestratorWorker) => {
    const label = formatAccountLabel(worker.statusSnapshot?.account) || worker.workerId;
    if (!window.confirm(lang('PromoOrchestrationStopConfirm', { account: label }))) return;
    setIsCommandBusy(true);
    try {
      await sendOrchestratorCommand(worker.workerId, 'stop');
      setActionError(undefined);
    } catch (err: any) {
      setActionError(lang('PromoOrchestrationCommandError', { error: err.message }));
    } finally {
      setIsCommandBusy(false);
    }
  });

  // One-shot manual copy of this daemon's campaign to another account: there
  // is no automatic sync by design, and the destination rebuilds rows with
  // its own local ids
  const handleCopyCampaign = useLastCallback(async (worker: OrchestratorWorker) => {
    const label = formatAccountLabel(worker.statusSnapshot?.account) || worker.workerId;
    if (!window.confirm(lang('PromoOrchestrationCopyCampaignConfirm', { account: label }))) return;
    setIsCommandBusy(true);
    try {
      const campaign = await fetchAutomationCampaign();
      if (!campaign.templates.length) {
        setActionError(lang('PromoOrchestrationCopyCampaignEmpty'));
        return;
      }
      await sendOrchestratorCommand(worker.workerId, 'campaign-copy', buildCampaignCopyPayload(campaign));
      setActionError(undefined);
    } catch (err: any) {
      setActionError(lang('PromoOrchestrationCommandError', { error: err.message }));
    } finally {
      setIsCommandBusy(false);
    }
  });

  const handleDefineOverride = useLastCallback(async () => {
    const meta = OVERRIDEABLE_FIELDS[overrideField];
    if (!meta) return;

    let value: OrchestratorOverrideValue;
    if (meta.type === 'mode') {
      value = overrideValueText === 'continuous' ? 'continuous' : 'manual';
    } else if (meta.type === 'boolean') {
      value = overrideValueText === 'true';
    } else if (meta.type === 'time') {
      if (!TIME_FORMAT_REGEX.test(overrideValueText)) {
        setActionError(lang('PromoOrchestrationInvalidTime'));
        return;
      }
      value = overrideValueText;
    } else {
      const parsed = Number(overrideValueText);
      if (!Number.isFinite(parsed) || parsed < 0) {
        setActionError(lang('PromoOrchestrationInvalidNumber'));
        return;
      }
      value = parsed;
    }

    setIsOverridesBusy(true);
    try {
      const res = await updateOrchestratorOverrides({ set: { [overrideField]: value } });
      setOverrides(res.overrides);
      setActionError(undefined);
    } catch (err: any) {
      setActionError(lang('PromoOrchestrationCommandError', { error: err.message }));
    } finally {
      setIsOverridesBusy(false);
    }
  });

  const handleClearOverride = useLastCallback(async (field: string) => {
    setIsOverridesBusy(true);
    try {
      const res = await updateOrchestratorOverrides({ clear: [field] });
      setOverrides(res.overrides);
      setActionError(undefined);
    } catch (err: any) {
      setActionError(lang('PromoOrchestrationCommandError', { error: err.message }));
    } finally {
      setIsOverridesBusy(false);
    }
  });

  const handleSelectOverrideField = useLastCallback((field: string) => {
    setOverrideField(field);
    const meta = OVERRIDEABLE_FIELDS[field];
    const current = overrides[field];
    // Prefill with the defined value when one exists, so editing is in place
    setOverrideValueText(
      current === undefined
        ? DEFAULT_OVERRIDE_VALUE_BY_TYPE[meta.type]
        : String(current),
    );
  });

  const handleOverrideValueChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setOverrideValueText(e.target.value);
  });

  const handleOverrideSelectChange = useLastCallback((e: ChangeEvent<HTMLSelectElement>) => {
    setOverrideValueText(e.target.value);
  });

  if (loadError) {
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
          <h3>{lang('PromoOrchestrationTitle')}</h3>
        </div>
        <div className={styles.hint}>{lang('PromoOrchestrationNotMaster')}</div>
      </div>
    );
  }

  if (!info) {
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
          <h3>{lang('PromoOrchestrationTitle')}</h3>
        </div>
        <div className={styles.loadingWrap}><Spinner /></div>
      </div>
    );
  }

  const overrideMeta = OVERRIDEABLE_FIELDS[overrideField];

  const renderOverrideValueInput = () => {
    if (overrideMeta.type === 'boolean') {
      return (
        <select
          className={styles.overrideSelect}
          value={overrideValueText}
          onChange={handleOverrideSelectChange}
        >
          <option value="true">{lang('PromoOrchestrationValueOn')}</option>
          <option value="false">{lang('PromoOrchestrationValueOff')}</option>
        </select>
      );
    }
    if (overrideMeta.type === 'mode') {
      return (
        <select
          className={styles.overrideSelect}
          value={overrideValueText}
          onChange={handleOverrideSelectChange}
        >
          <option value="manual">{lang('PromoAutomationModeManual')}</option>
          <option value="continuous">{lang('PromoAutomationModeContinuous')}</option>
        </select>
      );
    }
    return (
      <input
        className={styles.overrideInput}
        value={overrideValueText}
        inputMode={overrideMeta.type === 'number' ? 'numeric' : 'text'}
        placeholder={overrideMeta.type === 'time' ? '23:30' : '60'}
        onChange={handleOverrideValueChange}
      />
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
        <h3>{lang('PromoOrchestrationTitle')}</h3>
      </div>

      <div className={buildClassName(styles.scrollable, 'custom-scroll')}>
        <div className={styles.statsGrid}>
          <div className={styles.statCard}>
            <div className={styles.statValue}>
              {info.aliveWorkers}
              {' / '}
              {info.configuredWorkers}
            </div>
            <div className={styles.statLabel}>{lang('PromoOrchestrationWorkers')}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{info.totalTodaySent}</div>
            <div className={styles.statLabel}>{lang('PromoOrchestrationTodayTotal')}</div>
          </div>
          <div className={styles.statCard}>
            <div className={styles.statValue}>{info.degradedWorkers}</div>
            <div className={styles.statLabel}>{lang('PromoOrchestrationDegraded')}</div>
          </div>
        </div>

        {actionError && <div className={styles.actionError}>{actionError}</div>}

        <div className={styles.sectionTitle}>{lang('PromoOrchestrationAccounts')}</div>
        <div className={styles.list}>
          {workers.length === 0 && (
            <div className={styles.hint}>{lang('PromoOrchestrationNoWorkers')}</div>
          )}
          {workers.map((worker) => {
            const snap = worker.statusSnapshot;
            const scheduler = snap?.scheduler;
            const account = snap?.account;
            const accountLabel = formatAccountLabel(account);
            const digest = snap?.configDigest;
            const overriddenCount = snap?.overriddenFields?.length ?? 0;
            const isCommandPending = Boolean(worker.pendingCommand);
            const ack = worker.lastCommandAck;
            const agoSeconds = Math.max(0, Math.floor(loaderTarget / 1000) - worker.lastHeartbeatAt);
            const areActionsDisabled = !worker.isAlive || isCommandPending || isCommandBusy;
            return (
              <div key={worker.workerId} className={styles.listItem}>
                <div className={styles.workerHeader}>
                  <div className={styles.identityBlock}>
                    <span className={styles.workerId}>{worker.workerId}</span>
                    {accountLabel && (
                      <span className={styles.accountName} title={getAccountTitle(account)}>
                        {accountLabel}
                      </span>
                    )}
                    {account && (
                      <span className={styles.accountId}>
                        id
                        {account.userId}
                      </span>
                    )}
                  </div>
                  <span className={buildClassName(
                    styles.statusChip,
                    worker.isAlive
                      ? (scheduler?.status === 'RUNNING' ? styles.chipOk : styles.chipIdle)
                      : styles.chipOff,
                  )}
                  >
                    {worker.isAlive ? (scheduler?.status || 'IDLE') : lang('PromoOrchestrationOffline')}
                    {snap?.isDegraded ? ` · ${lang('PromoOrchestrationDegradedSuffix')}` : ''}
                  </span>
                </div>

                {digest && (
                  <div className={styles.digestRow}>
                    {buildDigestChips(digest, lang)}
                    {overriddenCount > 0 && (
                      <span className={styles.globalChip}>
                        {lang(
                          'PromoOrchestrationGlobalBadge',
                          { count: overriddenCount },
                          { pluralValue: overriddenCount },
                        )}
                      </span>
                    )}
                  </div>
                )}

                <div className={styles.itemMeta}>
                  <span>
                    {lang(
                      'PromoOrchestrationGroupsCount',
                      { count: worker.groups.length },
                      { pluralValue: worker.groups.length },
                    )}
                  </span>
                  {scheduler?.activeRound !== undefined && (
                    <span>
                      {lang('PromoOrchestrationRoundProgress', {
                        round: scheduler.activeRound,
                        sent: scheduler.sentInRoundCount ?? 0,
                        target: worker.metaTarget ?? digest?.roundTargetSends ?? '?',
                      })}
                    </span>
                  )}
                  <span>
                    {lang('PromoOrchestrationWorkerTodaySent', { count: snap?.todaySent ?? 0 })}
                  </span>
                  <span>
                    {lang('PromoOrchestrationHeartbeatAgo', {
                      duration: formatCountdownSeconds(agoSeconds),
                    })}
                  </span>
                </div>

                {isCommandPending && (
                  <div className={styles.commandState}>
                    {lang('PromoOrchestrationCommandPending', {
                      command: lang(
                        COMMAND_LABEL_KEYS[worker.pendingCommand!.type] || 'PromoOrchestrationCommandStart',
                      ),
                    })}
                  </div>
                )}
                {ack && !isCommandPending && (
                  <div className={buildClassName(
                    styles.commandState,
                    ack.ok ? styles.commandStateOk : styles.commandStateError,
                  )}
                  >
                    {ack.ok
                      ? (ack.message || lang('PromoOrchestrationCommandApplied'))
                      : (ack.error || lang('PromoOrchestrationCommandFailed'))}
                    {' · '}
                    {new Date(ack.at * 1000).toLocaleTimeString(lang.code)}
                  </div>
                )}

                <div className={styles.actionRow}>
                  <Button
                    size="tiny"
                    color="primary"
                    disabled={areActionsDisabled}
                    onClick={() => void handleStartWorker(worker)}
                  >
                    {lang('PromoOrchestrationStart')}
                  </Button>
                  <Button
                    size="tiny"
                    color="danger"
                    disabled={areActionsDisabled}
                    onClick={() => void handleStopWorker(worker)}
                  >
                    {lang('PromoOrchestrationStop')}
                  </Button>
                  {worker.workerId !== info.workerId && (
                    <Button
                      size="tiny"
                      color="secondary"
                      disabled={areActionsDisabled}
                      onClick={() => void handleCopyCampaign(worker)}
                    >
                      {lang('PromoOrchestrationCopyCampaign')}
                    </Button>
                  )}
                </div>
                <div className={styles.workerUrl}>{worker.apiUrl}</div>
              </div>
            );
          })}
        </div>

        <div className={styles.sectionTitle}>{lang('PromoOrchestrationGlobalValues')}</div>
        <div className={styles.globalHint}>{lang('PromoOrchestrationGlobalValuesHint')}</div>
        <div className={styles.list}>
          {Object.keys(overrides).length === 0 && (
            <div className={styles.hint}>{lang('PromoOrchestrationNoOverrides')}</div>
          )}
          {Object.entries(overrides).map(([field, value]) => (
            <div key={field} className={styles.overrideRow}>
              <span className={styles.overrideLabel}>{getOverrideFieldLabel(field, lang)}</span>
              <span className={styles.overrideValue}>{formatOverrideValue(field, value, lang)}</span>
              <Button
                round
                size="tiny"
                color="translucent"
                ariaLabel={lang('PromoOrchestrationRemoveOverride')}
                iconName="close"
                disabled={isOverridesBusy}
                onClick={() => void handleClearOverride(field)}
              />
            </div>
          ))}
        </div>
        <div className={styles.overrideForm}>
          <select
            className={styles.overrideSelect}
            value={overrideField}
            onChange={(e: ChangeEvent<HTMLSelectElement>) => handleSelectOverrideField(e.target.value)}
          >
            {OVERRIDE_FIELD_IDS.map((field) => (
              <option key={field} value={field}>{getOverrideFieldLabel(field, lang)}</option>
            ))}
          </select>
          {renderOverrideValueInput()}
          <Button
            size="tiny"
            color="primary"
            disabled={isOverridesBusy}
            onClick={() => void handleDefineOverride()}
          >
            {lang('PromoOrchestrationDefineOverride')}
          </Button>
        </div>
        {overrideField === 'roundTargetSends' && (
          <div className={styles.globalHint}>{lang('PromoOrchestrationRoundTargetHint')}</div>
        )}

        <div className={styles.sectionTitle}>{lang('PromoOrchestrationGrantsFeed')}</div>
        <div className={styles.list}>
          {grants.length === 0 && (
            <div className={styles.hint}>{lang('PromoOrchestrationNoGrants')}</div>
          )}
          {grants.map((grant) => (
            <div key={grant.id} className={styles.listItem}>
              <div className={styles.grantLine}>
                <Icon name={grant.result === 'success' ? 'check' : grant.result ? 'close' : 'clock'} />
                <span className={styles.grantWorker}>{grant.workerId}</span>
                <span className={styles.grantChat}>{grant.chatTitle}</span>
              </div>
              <div className={styles.itemMeta}>
                <span>{new Date(grant.grantedAt * 1000).toLocaleTimeString(lang.code)}</span>
                <span>{grant.result || lang('PromoOrchestrationGrantInProgress')}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default memo(PromoOrchestration);
