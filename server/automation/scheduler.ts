import type { AutomationDatabase, AutomationDbConfig, GroupStateRecord } from '../db/database';
import type { OrchestratorSendResult, OrchestratorWorkerClient } from '../orchestrator/workerClient';
import type { ChatProbeResult } from './telegramRunner';

import { compileSpunMessage, pickTemplate } from './spintax';

export type SchedulerStatus =
  | 'STOPPED'
  | 'RUNNING'
  | 'PAUSED'
  | 'SLEEP_WINDOW'
  | 'CIRCUIT_BREAKER'
  | 'MICRO_PAUSE'
  | 'WAITING_NEXT_ROUND'
  | 'WAITING_COOLDOWN'
  | 'WAITING_MESSAGES';

export interface SchedulerState {
  status: SchedulerStatus;
  currentChatId?: string;
  currentChatTitle?: string;
  nextRunAt?: number; // epoch ms
  sleepUntil?: number; // epoch ms
  activeRound: number;
  sentInRoundCount: number;
  consecutiveFloodWaits: number;
  consecutiveSendsInRun: number;
  waitingReason?: string;
  lastRunError?: string;
  wasInSleepWindow?: boolean;
  // UI-facing end of the current long wait (sleep slices are internal);
  // during the sleep window this holds the window end instead
  waitTotalUntil?: number;
}

export function isInsideSleepWindow(startStr: string, endStr: string, now = new Date()): boolean {
  const [startHour, startMin] = startStr.split(':').map(Number);
  const [endHour, endMin] = endStr.split(':').map(Number);

  if (startHour === undefined || startMin === undefined || endHour === undefined || endMin === undefined) {
    return false;
  }

  const currentMinutes = now.getHours() * 60 + now.getMinutes();
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;

  if (startMinutes <= endMinutes) {
    return currentMinutes >= startMinutes && currentMinutes < endMinutes;
  }

  // Crosses midnight (e.g. 23:30 to 07:30)
  return currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

// Absolute timestamp (ms) at which the sleep window ends, if inside it now
export function getSleepWindowEndMs(startStr: string, endStr: string, now = new Date()): number | undefined {
  if (!isInsideSleepWindow(startStr, endStr, now)) return undefined;

  const [endHour, endMin] = endStr.split(':').map(Number);
  const end = new Date(now);
  end.setHours(endHour, endMin, 0, 0);
  if (end.getTime() <= now.getTime()) {
    end.setDate(end.getDate() + 1);
  }
  return end.getTime();
}

export function calculateJitterDelayMs(minSec: number, maxSec: number): number {
  const min = Math.max(1, minSec);
  const max = Math.max(min, maxSec);

  // Box-Muller pseudo-gaussian centered between min and max
  const u1 = Math.max(1e-6, Math.random());
  const u2 = Math.random();
  const z0 = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

  const mean = (min + max) / 2;
  const stdDev = (max - min) / 6; // ~99.7% of values fall within [min, max]
  const rawSec = mean + z0 * stdDev;

  const clampedSec = Math.max(min, Math.min(max, rawSec));
  return Math.round(clampedSec * 1000);
}

export function evaluateGroupEligibility(
  group: GroupStateRecord,
  minOtherMessages: number,
  serverNow: number,
  minResendIntervalMinutes = 0,
): { isEligible: boolean;
  reason: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'WAITING_RESEND' | 'BLOCKED' | 'STARS';
} {
  if (group.status === 'BLOCKED') {
    return { isEligible: false, reason: 'BLOCKED' };
  }

  if (group.status === 'STARS' || (group.starsCost || 0) > 0) {
    return { isEligible: false, reason: 'STARS' };
  }

  // 1. Check slowmode next send date
  if (group.slowmodeNextSendDate && group.slowmodeNextSendDate > serverNow) {
    return { isEligible: false, reason: 'WAITING_SLOWMODE' };
  }

  // 2. Check last sent time + slowmode window
  if (group.lastSentAt && group.slowmodeSeconds > 0) {
    if (group.lastSentAt + group.slowmodeSeconds > serverNow) {
      return { isEligible: false, reason: 'WAITING_SLOWMODE' };
    }
  }

  // 2b. Minimum wait between our own sends to the same group
  if (minResendIntervalMinutes > 0 && group.lastSentAt) {
    if (group.lastSentAt + minResendIntervalMinutes * 60 > serverNow) {
      return { isEligible: false, reason: 'WAITING_RESEND' };
    }
  }

  // 3. Strict N other messages requirement:
  // Must have received at least minOtherMessages from other users before sending again!
  if (group.lastSentAt && group.otherMessagesCount < minOtherMessages) {
    return { isEligible: false, reason: 'WAITING_MESSAGES' };
  }

  return { isEligible: true, reason: 'READY' };
}

interface SendResult {
  success: boolean;
  isPaymentRequired?: boolean;
  isSessionLost?: boolean;
  slowmodeSeconds?: number;
  floodWaitSeconds?: number;
  error?: string;
}

type SendCallback = (chatId: string, text: string, linkUsed: string) => Promise<SendResult>;
type CheckMessagesCallback = (chatId: string, minRequired: number) => Promise<number>;
type ProbeChatCallback = (chatId: string) => Promise<ChatProbeResult | undefined>;

const REVALIDATE_INTERVAL_MS = 30 * 60_000;
const REVALIDATE_BATCH_SIZE = 10;
// While some quarantined group has not been probed in this process yet,
// probe faster so stale classifications (e.g. from cached frontend state)
// are corrected within minutes instead of hours
const REVALIDATE_CATCHUP_INTERVAL_MS = 60_000;

export class AutomationScheduler {
  private state: SchedulerState = {
    status: 'STOPPED',
    activeRound: 0,
    sentInRoundCount: 0,
    consecutiveFloodWaits: 0,
    consecutiveSendsInRun: 0,
  };

  private abortController?: AbortController;

  private loopPromise?: Promise<void>;

  private sleepResolve?: () => void;

  private skipRequested = false;

  constructor(
    private readonly db: AutomationDatabase,
    private readonly sendCallback: SendCallback,
    private readonly checkMessagesCallback?: CheckMessagesCallback,
    private readonly probeChatCallback?: ProbeChatCallback,
    private readonly orchestratorClient?: OrchestratorWorkerClient,
  ) {}

  private lastRevalidateAt = 0;

  private lastProbeAtByChat = new Map<string, number>();

  private waitStartMs?: number;

  private lastWaitLogToken?: string;

  // Logs a wait transition only when the queue stays in that wait kind for
  // at least a minute, so genuinely idle periods appear in the history
  // without spamming it on short inter-send cooldowns.
  private logWaitTransitionOnce(token: string, snippet: string, createdAt: number) {
    const now = Date.now();
    if (this.waitStartMs === undefined) {
      this.waitStartMs = now;
      return;
    }
    if (now - this.waitStartMs < 60_000 || this.lastWaitLogToken === token) return;
    this.lastWaitLogToken = token;
    this.db.addLog({
      createdAt,
      chatId: 'system',
      chatTitle: 'Sistema de Automação',
      messageSnippet: snippet,
      linkUsed: '',
      status: 'SKIPPED',
    });
  }

  private clearWaitTracking() {
    this.waitStartMs = undefined;
    this.lastWaitLogToken = undefined;
  }

  getState(): Readonly<SchedulerState> {
    return { ...this.state };
  }

  start() {
    if (this.state.status === 'RUNNING') return;

    this.abortController = new AbortController();
    this.state.status = 'RUNNING';
    this.state.activeRound++;
    this.state.consecutiveSendsInRun = 0;
    this.state.sentInRoundCount = 0;
    this.state.lastRunError = undefined;
    this.loopPromise = this.runLoop(this.abortController.signal);
  }

  stop() {
    this.state.status = 'STOPPED';
    this.state.currentChatId = undefined;
    this.state.currentChatTitle = undefined;
    this.state.nextRunAt = undefined;
    this.state.sleepUntil = undefined;
    this.state.sentInRoundCount = 0;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  resetRound() {
    this.state.sentInRoundCount = 0;
  }

  forceNewRound() {
    this.state.sentInRoundCount = 0;
    this.state.activeRound++;
    this.skipPause();
  }

  skipPause() {
    this.skipRequested = true;
    if (this.sleepResolve) {
      const resolve = this.sleepResolve;
      this.sleepResolve = undefined;
      this.state.sleepUntil = undefined;
      resolve();
    }
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.state.sleepUntil = Date.now() + ms;
    return new Promise((resolve, reject) => {
      let isDone = false;

      const cleanup = () => {
        if (isDone) return;
        isDone = true;
        clearTimeout(timeout);
        signal.removeEventListener('abort', onAbort);
        this.sleepResolve = undefined;
        this.state.sleepUntil = undefined;
      };

      const timeout = setTimeout(() => {
        cleanup();
        resolve();
      }, ms);

      const onAbort = () => {
        cleanup();
        reject(new Error('Scheduler stopped'));
      };

      this.sleepResolve = () => {
        cleanup();
        resolve();
      };

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // Sleeps in 60s slices so long waits re-check the sleep window (and stay
  // responsive to stop). Time spent inside the sleep window does not count
  // toward the requested wait.
  private async sleepWithWindowCheck(
    ms: number,
    config: Pick<AutomationDbConfig, 'sleepWindowEnabled' | 'sleepWindowStart' | 'sleepWindowEnd'>,
    signal: AbortSignal,
  ) {
    let remainingMs = ms;
    try {
      while (remainingMs > 0 && !signal.aborted) {
        this.state.waitTotalUntil = Date.now() + remainingMs;
        if (await this.enterSleepWindowIfActive(config, signal)) continue;
        if (this.skipRequested) {
          this.skipRequested = false;
          break;
        }
        const chunkMs = Math.min(remainingMs, 60_000);
        await this.sleep(chunkMs, signal);
        remainingMs -= chunkMs;
      }
    } finally {
      this.state.waitTotalUntil = undefined;
    }
    this.exitSleepWindowIfFinished(config, signal);
  }

  // Returns true while inside the configured sleep window. Logs the
  // transition once per entry.
  private async enterSleepWindowIfActive(
    config: Pick<AutomationDbConfig, 'sleepWindowEnabled' | 'sleepWindowStart' | 'sleepWindowEnd'>,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!config.sleepWindowEnabled
      || !isInsideSleepWindow(config.sleepWindowStart, config.sleepWindowEnd)) {
      return false;
    }

    if (!this.state.wasInSleepWindow) {
      this.state.wasInSleepWindow = true;
      this.db.addLog({
        createdAt: Math.floor(Date.now() / 1000),
        chatId: 'system',
        chatTitle: 'Sistema de Automação',
        messageSnippet: `Janela de sono ativada (${config.sleepWindowStart}–${config.sleepWindowEnd}). `
          + 'Envios pausados.',
        linkUsed: '',
        status: 'SKIPPED',
      });
    }

    // The sleep window is never skippable; swallow stray requests
    this.skipRequested = false;
    this.state.status = 'SLEEP_WINDOW';
    const windowEndMs = getSleepWindowEndMs(config.sleepWindowStart, config.sleepWindowEnd);
    if (windowEndMs) this.state.waitTotalUntil = windowEndMs;
    await this.sleep(60_000, signal);
    this.state.status = 'RUNNING';
    return true;
  }

  private exitSleepWindowIfFinished(
    config: Pick<AutomationDbConfig, 'sleepWindowEnabled' | 'sleepWindowStart' | 'sleepWindowEnd'>,
    signal: AbortSignal,
  ) {
    if (!this.state.wasInSleepWindow || signal.aborted) return;
    if (config.sleepWindowEnabled
      && isInsideSleepWindow(config.sleepWindowStart, config.sleepWindowEnd)) {
      return;
    }

    this.state.wasInSleepWindow = undefined;
    this.state.waitTotalUntil = undefined;
    this.db.addLog({
      createdAt: Math.floor(Date.now() / 1000),
      chatId: 'system',
      chatTitle: 'Sistema de Automação',
      messageSnippet: 'Janela de sono encerrada. Retomando envios.',
      linkUsed: '',
      status: 'SKIPPED',
    });
  }

  // Periodically probes groups with read-only API calls. Two scopes:
  // (a) every group is probed once per process (startup sweep — catches
  //     write-forbidden/stars groups before any send is attempted);
  // (b) quarantined groups are re-probed every 30 min to detect groups that
  //     stopped charging/blocking. Probe order is fair (least-recently-probed
  //     first) so no group can starve the queue.
  private async revalidateQuarantinedGroups(signal: AbortSignal) {
    if (!this.probeChatCallback) return;

    const allGroups = this.db.getAllGroupStates();
    const now = Date.now();

    const quarantined = allGroups.filter((g) => g.status === 'STARS' || g.status === 'BLOCKED');
    const unprobed = allGroups.filter((g) => !this.lastProbeAtByChat.has(g.chatId));
    if (!quarantined.length && !unprobed.length) return;

    const interval = unprobed.length ? REVALIDATE_CATCHUP_INTERVAL_MS : REVALIDATE_INTERVAL_MS;
    if (now - this.lastRevalidateAt < interval) return;
    this.lastRevalidateAt = now;

    const targetById = new Map<string, GroupStateRecord>();
    for (const g of quarantined) targetById.set(g.chatId, g);
    for (const g of unprobed) targetById.set(g.chatId, g);

    const queue = [...targetById.values()]
      .sort((a, b) => (this.lastProbeAtByChat.get(a.chatId) || 0) - (this.lastProbeAtByChat.get(b.chatId) || 0))
      .slice(0, REVALIDATE_BATCH_SIZE);

    let probedCount = 0;
    let reintegratedCount = 0;

    for (const g of queue) {
      if (signal.aborted) return;

      this.lastProbeAtByChat.set(g.chatId, now);
      const probe = await this.probeChatCallback(g.chatId);
      if (!probe) continue;
      probedCount++;

      const serverNow = Math.floor(Date.now() / 1000);

      if (!probe.canWrite) {
        if (g.status !== 'BLOCKED') {
          this.db.upsertGroupState({
            chatId: g.chatId,
            title: g.title,
            otherMessagesCount: g.otherMessagesCount,
            slowmodeSeconds: g.slowmodeSeconds,
            slowmodeNextSendDate: g.slowmodeNextSendDate,
            starsCost: g.starsCost,
            lastSentAt: g.lastSentAt,
            status: 'BLOCKED',
            lastError: 'Canal inacessível na revalidação',
          });
          if (g.status !== 'STARS') {
            this.db.addLog({
              createdAt: serverNow,
              chatId: g.chatId,
              chatTitle: g.title,
              messageSnippet: `Grupo "${g.title}" não aceita mensagens da conta `
                + '(saída/banimento/trancado) — quarentenado.',
              linkUsed: '',
              status: 'SKIPPED',
            });
          }
        }
        continue;
      }

      const starsCost = probe.starsCost || 0;
      if (starsCost > 0) {
        if (g.status !== 'STARS' && g.status !== 'BLOCKED') {
          this.db.addLog({
            createdAt: serverNow,
            chatId: g.chatId,
            chatTitle: g.title,
            messageSnippet: `Grupo "${g.title}" passou a cobrar ${starsCost} estrelas — quarentenado.`,
            linkUsed: '',
            status: 'SKIPPED',
          });
        }
        if (g.status !== 'STARS' || g.starsCost !== starsCost) {
          this.db.upsertGroupState({
            chatId: g.chatId,
            title: g.title,
            otherMessagesCount: g.otherMessagesCount,
            slowmodeSeconds: g.slowmodeSeconds,
            slowmodeNextSendDate: g.slowmodeNextSendDate,
            starsCost,
            lastSentAt: g.lastSentAt,
            status: 'STARS',
            lastError: undefined,
          });
        }
        continue;
      }

      // Free again: reintegrate into the queue
      this.db.upsertGroupState({
        chatId: g.chatId,
        title: g.title,
        otherMessagesCount: g.otherMessagesCount,
        slowmodeSeconds: probe.slowmodeSeconds !== undefined ? probe.slowmodeSeconds : g.slowmodeSeconds,
        slowmodeNextSendDate: g.slowmodeNextSendDate,
        starsCost: 0,
        lastSentAt: g.lastSentAt,
        status: 'READY',
        lastError: undefined,
      });
      this.db.addLog({
        createdAt: serverNow,
        chatId: g.chatId,
        chatTitle: g.title,
        messageSnippet: `Grupo "${g.title}" deixou de cobrar estrelas/bloquear e foi reintegrado à fila.`,
        linkUsed: '',
        status: 'SKIPPED',
      });
      reintegratedCount++;
    }

    if (probedCount > 0) {
      const remainingUnprobed = allGroups.filter(
        (g) => !this.lastProbeAtByChat.has(g.chatId),
      ).length;
      this.db.addLog({
        createdAt: Math.floor(Date.now() / 1000),
        chatId: 'system',
        chatTitle: 'Sistema de Automação',
        messageSnippet: `Sondagem de grupos: ${probedCount} verificado(s), `
          + `${reintegratedCount} reintegrado(s)`
          + (remainingUnprobed ? `, ${remainingUnprobed} aguardando 1ª sondagem.` : '.'),
        linkUsed: '',
        status: 'SKIPPED',
      });
    }
  }

  private async runLoop(signal: AbortSignal) {
    try {
      while (!signal.aborted && this.state.status === 'RUNNING') {
        const config = this.db.getConfig();
        const serverNow = Math.floor(Date.now() / 1000);

        // 1. Sleep window check (re-evaluated at every loop iteration and
        // inside long waits via sleepWithWindowCheck)
        if (await this.enterSleepWindowIfActive(config, signal)) {
          continue;
        }
        this.exitSleepWindowIfFinished(config, signal);

        // 1b. Quarantined groups (stars/blocked) may become free again:
        // re-probe a small batch periodically without sending anything
        await this.revalidateQuarantinedGroups(signal);

        // 2. Daily limit check
        const todaySent = this.db.getTodaySentCount(serverNow);
        if (todaySent >= config.dailyLimit) {
          this.state.lastRunError = `Daily limit reached (${todaySent}/${config.dailyLimit})`;
          await this.sleepWithWindowCheck(300_000, config, signal);
          continue;
        }

        // 3. Human micro-pause check
        if (config.microPauseEnabled) {
          const minSends = Math.max(1, config.microPauseEveryMin);
          const maxSends = Math.max(minSends, config.microPauseEveryMax);
          const thresholdRange = maxSends - minSends + 1;
          const microPauseThreshold = minSends + (this.state.activeRound % thresholdRange);

          if (this.state.consecutiveSendsInRun >= microPauseThreshold) {
            this.state.status = 'MICRO_PAUSE';
            const pauseSec = Math.max(10, config.microPauseSeconds);
            const pauseMin = (pauseSec / 60).toFixed(1);

            const pauseSnippet = `Pausa anti-ban ativada: aguardando ${pauseMin} min (${pauseSec}s) `
              + `após ${this.state.consecutiveSendsInRun} envios consecutivos.`;
            this.db.addLog({
              createdAt: serverNow,
              chatId: 'system',
              chatTitle: 'Sistema de Automação',
              messageSnippet: pauseSnippet,
              linkUsed: '',
              status: 'SKIPPED',
            });

            await this.sleepWithWindowCheck(pauseSec * 1000, config, signal);
            this.state.consecutiveSendsInRun = 0;
            this.state.status = 'RUNNING';
            continue;
          }
        }

        // 4. Round target check: conclude round when the send goal is reached
        const roundTarget = Math.max(1, config.roundTargetSends);
        if (this.state.sentInRoundCount >= roundTarget) {
          const snippet = `Rodada #${this.state.activeRound} concluída: meta de `
            + `${roundTarget} envios atingida.`;

          if (config.mode === 'manual') {
            this.state.status = 'STOPPED';
            this.db.addLog({
              createdAt: serverNow,
              chatId: 'system',
              chatTitle: 'Sistema de Automação',
              messageSnippet: snippet,
              linkUsed: '',
              status: 'SUCCESS',
            });
            break;
          }

          this.state.status = 'WAITING_NEXT_ROUND';
          this.db.addLog({
            createdAt: serverNow,
            chatId: 'system',
            chatTitle: 'Sistema de Automação',
            messageSnippet: `${snippet} Próxima rodada em ${config.roundIntervalMinutes} min.`,
            linkUsed: '',
            status: 'SUCCESS',
          });

          const pauseMs = Math.max(1, config.roundIntervalMinutes) * 60 * 1000;
          await this.sleepWithWindowCheck(pauseMs, config, signal);
          this.state.sentInRoundCount = 0;
          this.state.consecutiveSendsInRun = 0;
          this.state.activeRound++;
          this.state.status = 'RUNNING';
          continue;
        }

        // 5. Find all valid groups (excluding blocked chats and chats that charge stars)
        const allGroups = this.db.getAllGroupStates();
        const validGroups = allGroups.filter((g) => (
          g.status !== 'BLOCKED'
          && g.status !== 'STARS'
          && (g.starsCost || 0) === 0
        ));

        if (validGroups.length === 0) {
          const quarantinedCount = this.db.getAllGroupStates()
            .filter((g) => g.status === 'STARS' || g.status === 'BLOCKED').length;

          if (quarantinedCount > 0) {
            // Everything is quarantined: keep the loop alive so revalidation
            // (step 1b) can reintegrate groups that stopped charging/blocking
            this.logWaitTransitionOnce(
              'QUARANTINED',
              `Todos os ${quarantinedCount} grupos estão em quarentena. `
              + 'Revalidando em ciclo rápido até algum ficar livre…',
              serverNow,
            );
            this.lastRevalidateAt = 0;
            this.state.status = 'WAITING_MESSAGES';
            this.state.waitingReason = 'Todos os grupos em quarentena — revalidando';
            await this.sleep(REVALIDATE_CATCHUP_INTERVAL_MS, signal);
            this.state.waitingReason = undefined;
            this.state.status = 'RUNNING';
            continue;
          }

          this.state.lastRunError = 'Nenhum grupo válido configurado na pasta';
          this.state.status = 'STOPPED';
          break;
        }

        // Evaluate eligibility for all valid groups
        const readyGroups: GroupStateRecord[] = [];
        let minSlowmodeWaitSeconds = Infinity;
        let slowestGroupTitle = '';
        let countWaitingSlowmode = 0;
        let countWaitingMessages = 0;

        for (const g of validGroups) {
          let evalResult = evaluateGroupEligibility(
            g,
            config.minOtherMessages,
            serverNow,
            config.minResendIntervalMinutes,
          );

          if (evalResult.reason === 'WAITING_SLOWMODE' || evalResult.reason === 'WAITING_RESEND') {
            // Cooldown only "counts" for groups that already satisfy the
            // other-messages rule — otherwise waiting out the cooldown would
            // still not produce a send, which makes the UI spin between
            // groups without ever sending (those groups are really waiting
            // for messages).
            const meetsMessages = !g.lastSentAt
              || g.otherMessagesCount >= config.minOtherMessages
              || (this.checkMessagesCallback
                ? (await this.checkMessagesCallback(g.chatId, config.minOtherMessages)) >= config.minOtherMessages
                : false);

            if (!meetsMessages) {
              countWaitingMessages++;
            } else {
              countWaitingSlowmode++;
              let remaining: number;
              if (evalResult.reason === 'WAITING_RESEND') {
                remaining = (g.lastSentAt || serverNow) + config.minResendIntervalMinutes * 60 - serverNow;
              } else {
                remaining = g.slowmodeNextSendDate && g.slowmodeNextSendDate > serverNow
                  ? g.slowmodeNextSendDate - serverNow : (g.slowmodeSeconds || 60);
              }
              if (remaining < minSlowmodeWaitSeconds) {
                minSlowmodeWaitSeconds = remaining;
                slowestGroupTitle = g.title;
              }
            }
          } else if (evalResult.reason === 'WAITING_MESSAGES') {
            countWaitingMessages++;
            // Check Telegram history only if needed (debounced with 5m cache inside runner)
            if (this.checkMessagesCallback) {
              const verifiedCount = await this.checkMessagesCallback(g.chatId, config.minOtherMessages);
              if (verifiedCount >= config.minOtherMessages) {
                evalResult = { isEligible: true, reason: 'READY' };
                countWaitingMessages--;
              }
            }
          }

          if (evalResult.isEligible) {
            readyGroups.push(g);
          }
        }

        let eligibleGroup: GroupStateRecord | undefined;

        if (readyGroups.length > 0) {
          // Prioritize groups that have gone the longest without a message from us
          readyGroups.sort((a, b) => {
            const timeA = a.lastSentAt || 0;
            const timeB = b.lastSentAt || 0;
            return timeA - timeB;
          });
          eligibleGroup = readyGroups[0];
          this.clearWaitTracking();
        }

        if (!eligibleGroup) {
          // No groups currently satisfy all criteria
          if (countWaitingSlowmode > 0) {
            this.logWaitTransitionOnce(
              'COOLDOWN',
              `Nenhum grupo elegível. Aguardando cooldown — próximo disponível: `
              + `${slowestGroupTitle} em ~${Math.round(minSlowmodeWaitSeconds)}s.`,
              serverNow,
            );
            this.state.status = 'WAITING_COOLDOWN';
            this.state.currentChatTitle = slowestGroupTitle;
            this.state.waitingReason = `Aguardando cooldown de ${slowestGroupTitle}`;
            const waitMs = Math.min(Math.max(5, minSlowmodeWaitSeconds), 30) * 1000;
            await this.sleep(waitMs, signal);
            this.state.currentChatTitle = undefined;
            this.state.waitingReason = undefined;
            this.state.status = 'RUNNING';
            continue;
          }

          if (countWaitingMessages > 0) {
            this.logWaitTransitionOnce(
              'MESSAGES',
              `Nenhum grupo elegível. Todos aguardam ${config.minOtherMessages}+ mensagens de terceiros.`,
              serverNow,
            );
            this.state.status = 'WAITING_MESSAGES';
            this.state.waitingReason = `Aguardando novas mensagens nos grupos (mínimo: ${config.minOtherMessages})`;
            await this.sleep(15_000, signal);
            this.state.waitingReason = undefined;
            this.state.status = 'RUNNING';
            continue;
          }

          this.logWaitTransitionOnce(
            'IDLE',
            'Nenhum grupo elegível no momento (todos em cooldown, aguardando mensagens ou quarentenados).',
            serverNow,
          );
          await this.sleep(15_000, signal);
          continue;
        }

        // 6. Compile and send message
        const campaign = this.db.getCampaign();
        const template = pickTemplate(campaign.templates, config.templateRotationEnabled);
        if (!template) {
          this.state.lastRunError = 'No campaign template configured';
          this.state.status = 'STOPPED';
          break;
        }

        this.state.currentChatId = eligibleGroup.chatId;
        this.state.currentChatTitle = eligibleGroup.title;

        // Orchestrator claim: when orchestrated, only the slot owner may send.
        // Degraded mode (master unreachable) falls back to local sending.
        if (this.orchestratorClient) {
          const claim = await this.orchestratorClient.claimSendSlot(eligibleGroup.chatId, eligibleGroup.title);
          if (claim && !claim.granted) {
            this.state.status = 'WAITING_COOLDOWN';
            this.state.waitingReason = 'Aguardando slot global do orquestrador';
            const waitMs = Math.min(Math.max(5, (claim.retryAfterMs || 15_000) / 1000), 30) * 1000;
            await this.sleep(waitMs, signal);
            this.state.waitingReason = undefined;
            this.state.status = 'RUNNING';
            continue;
          }
        }

        // Pacing delay with jitter BEFORE sending
        const delayMs = calculateJitterDelayMs(config.minDelaySeconds, config.maxDelaySeconds);
        this.state.nextRunAt = Date.now() + delayMs;
        await this.sleep(delayMs, signal);

        // Execute send
        const { messageText, linkUsed } = compileSpunMessage(template.content, campaign.links);
        const sendResult = await this.sendCallback(eligibleGroup.chatId, messageText, linkUsed);

        const timestamp = Math.floor(Date.now() / 1000);

        if (this.orchestratorClient) {
          const reportResult: OrchestratorSendResult = sendResult.success
            ? 'success'
            : sendResult.isPaymentRequired
              ? 'stars'
              : sendResult.slowmodeSeconds
                ? 'slowmode'
                : sendResult.floodWaitSeconds
                  ? 'flood'
                  : /CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHAT_RESTRICTED/
                    .test(sendResult.error || '')
                    ? 'blocked'
                    : 'error';
          void this.orchestratorClient.reportSendResult(eligibleGroup.chatId, reportResult);
        }

        if (sendResult.isSessionLost) {
          this.db.addLog({
            createdAt: timestamp,
            chatId: 'system',
            chatTitle: 'Sistema de Automação',
            messageSnippet: 'Sessão perdida (outro cliente assumiu — ex.: o webapp foi aberto). '
              + 'Automação parada; inicie de novo pelo painel ou via takeover remoto.',
            linkUsed: '',
            status: 'ERROR',
            details: sendResult.error,
          });
          this.state.lastRunError = sendResult.error;
          this.state.status = 'STOPPED';
          break;
        }

        if (sendResult.success) {
          this.state.consecutiveFloodWaits = 0;
          this.state.consecutiveSendsInRun++;
          this.state.sentInRoundCount++;
          this.db.resetGroupOtherMessages(eligibleGroup.chatId, timestamp);
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
            templateId: template.id,
            linkUsed,
            status: 'SUCCESS',
          });
        } else if (sendResult.isPaymentRequired) {
          // Group requires Stars payment - the runner already quarantined it in the DB.
          // Just log the skip; the validGroups filter will exclude it from now on
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
            templateId: template.id,
            linkUsed,
            status: 'SKIPPED',
            details: sendResult.error || 'Grupo cobra estrelas (excluído da automação)',
          });
        } else if (sendResult.slowmodeSeconds) {
          // Group is in slowmode cooldown - do NOT pause entire queue, just log and move to next group
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
            templateId: template.id,
            linkUsed,
            status: 'SKIPPED',
            details: sendResult.error || `Em slowmode: aguardando ${sendResult.slowmodeSeconds}s`,
          });
        } else if (sendResult.floodWaitSeconds) {
          this.state.consecutiveFloodWaits++;
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
            templateId: template.id,
            linkUsed,
            status: 'FLOOD_WAIT',
            details: `Flood wait: ${sendResult.floodWaitSeconds}s`,
          });

          // Circuit breaker: 2 consecutive flood waits = global 1 hour pause
          if (this.state.consecutiveFloodWaits >= 2) {
            this.state.status = 'CIRCUIT_BREAKER';
            this.state.lastRunError = 'Triggered Circuit Breaker: 2 consecutive flood waits. Pausing 1h.';
            await this.sleepWithWindowCheck(3600_000, config, signal);
            this.state.consecutiveFloodWaits = 0;
            this.state.status = 'RUNNING';
          } else {
            await this.sleep((sendResult.floodWaitSeconds + 30) * 1000, signal);
          }
        } else {
          const isPermError = /CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHAT_RESTRICTED/
            .test(sendResult.error || '');
          if (isPermError) {
            this.db.upsertGroupState({
              chatId: eligibleGroup.chatId,
              title: eligibleGroup.title,
              otherMessagesCount: eligibleGroup.otherMessagesCount,
              slowmodeSeconds: eligibleGroup.slowmodeSeconds,
              starsCost: eligibleGroup.starsCost,
              lastSentAt: eligibleGroup.lastSentAt,
              status: 'BLOCKED',
              lastError: sendResult.error,
            });
          }
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
            templateId: template.id,
            linkUsed,
            status: 'ERROR',
            details: sendResult.error,
          });
        }

        this.state.currentChatId = undefined;
        this.state.currentChatTitle = undefined;
        this.state.nextRunAt = undefined;
      }
    } catch (err: any) {
      if (err.message !== 'Scheduler stopped') {
        this.state.lastRunError = err.message;
      }
    } finally {
      if (this.state.status === 'RUNNING') {
        this.state.status = 'STOPPED';
      }
    }
  }
}
