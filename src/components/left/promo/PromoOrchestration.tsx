import {
  memo,
  useEffect,
  useState,
} from '../../../lib/teact/teact';

import buildClassName from '../../../util/buildClassName';
import {
  fetchOrchestratorGrants,
  fetchOrchestratorInfo,
  fetchOrchestratorWorkers,
  type OrchestratorGrant,
  type OrchestratorInfo,
  type OrchestratorWorker,
} from '../../../util/promo/automationApi';
import { formatCountdownSeconds } from '../../../util/promo/countdownFormat';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';

import Icon from '../../common/icons/Icon';
import Button from '../../ui/Button';
import Spinner from '../../ui/Spinner';

import styles from './PromoOrchestration.module.scss';

type OwnProps = {
  isActive: boolean;
  onReset: () => void;
};

const REFRESH_INTERVAL_MS = 5000;

const PromoOrchestration = ({ isActive, onReset }: OwnProps) => {
  const [info, setInfo] = useState<OrchestratorInfo>();
  const [workers, setWorkers] = useState<OrchestratorWorker[]>([]);
  const [grants, setGrants] = useState<OrchestratorGrant[]>([]);
  const [loaderTarget, setLoaderTarget] = useState(0);
  const [loadError, setLoadError] = useState<string>();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const lang = useLang();

  useEffect(() => {
    if (!isActive) return undefined;

    let isCancelled = false;

    const load = async () => {
      try {
        const [nextInfo, nextWorkers, nextGrants] = await Promise.all([
          fetchOrchestratorInfo(),
          fetchOrchestratorWorkers(),
          fetchOrchestratorGrants(50),
        ]);
        if (isCancelled) return;
        setInfo(nextInfo);
        setWorkers(nextWorkers);
        setGrants(nextGrants);
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

  const ownStatus = info;

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

  if (!ownStatus) {
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

        <div className={styles.sectionTitle}>{lang('PromoOrchestrationAccounts')}</div>
        <div className={styles.list}>
          {workers.length === 0 && (
            <div className={styles.hint}>{lang('PromoOrchestrationNoWorkers')}</div>
          )}
          {workers.map((worker) => {
            const snap = worker.statusSnapshot?.scheduler;
            const agoSeconds = Math.max(0, Math.floor(loaderTarget / 1000) - worker.lastHeartbeatAt);
            return (
              <div key={worker.workerId} className={styles.listItem}>
                <div className={styles.workerHeader}>
                  <span className={styles.workerId}>{worker.workerId}</span>
                  <span className={buildClassName(
                    styles.statusChip,
                    worker.isAlive ? (snap?.status === 'RUNNING' ? styles.chipOk : styles.chipIdle) : styles.chipOff,
                  )}
                  >
                    {worker.isAlive ? (snap?.status || 'IDLE') : 'OFFLINE'}
                    {worker.statusSnapshot?.isDegraded ? ' · degradado' : ''}
                  </span>
                </div>
                <div className={styles.itemMeta}>
                  <span>
                    {lang(
                      'PromoOrchestrationGroupsCount',
                      { count: worker.groups.length },
                      { pluralValue: worker.groups.length },
                    )}
                  </span>
                  {snap?.activeRound !== undefined && (
                    <span>
                      Rodada
                      {' '}
                      {snap.activeRound}
                      {' · '}
                      {snap.sentInRoundCount ?? 0}
                      /
                      {worker.metaTarget ?? '?'}
                    </span>
                  )}
                  <span>
                    envios 24h:
                    {worker.statusSnapshot?.todaySent ?? 0}
                  </span>
                  <span>
                    hb
                    {formatCountdownSeconds(agoSeconds)}
                    {' '}
                    atrás
                  </span>
                </div>
                <div className={styles.workerUrl}>{worker.apiUrl}</div>
              </div>
            );
          })}
        </div>

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
                <span>{grant.result || 'em andamento'}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default memo(PromoOrchestration);
