import type { AutomationDatabase, GroupStateRecord } from '../db/database';

import { compileSpunMessage } from './spintax';

export interface SchedulerState {
  status: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'SLEEP_WINDOW' | 'CIRCUIT_BREAKER' | 'MICRO_PAUSE' | 'WAITING_NEXT_ROUND';
  currentChatId?: string;
  currentChatTitle?: string;
  nextRunAt?: number; // epoch ms
  sleepUntil?: number; // epoch ms
  activeRound: number;
  sentInRoundCount: number;
  consecutiveFloodWaits: number;
  consecutiveSendsInRun: number;
  lastRunError?: string;
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
): { isEligible: boolean; reason: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' | 'STARS' } {
  if (group.status === 'BLOCKED') {
    return { isEligible: false, reason: 'BLOCKED' };
  }

  if (group.status === 'STARS' || (group.starsCost || 0) > 0) {
    return { isEligible: false, reason: 'STARS' };
  }

  // Check slowmode next send date
  if (group.slowmodeNextSendDate && group.slowmodeNextSendDate > serverNow) {
    return { isEligible: false, reason: 'WAITING_SLOWMODE' };
  }

  // Check last sent time + slowmode window
  if (group.lastSentAt && group.slowmodeSeconds > 0) {
    if (group.lastSentAt + group.slowmodeSeconds > serverNow) {
      return { isEligible: false, reason: 'WAITING_SLOWMODE' };
    }
  }

  // Strict N other messages requirement applies only once we have sent to this group previously
  if (group.lastSentAt && group.otherMessagesCount < minOtherMessages) {
    return { isEligible: false, reason: 'WAITING_MESSAGES' };
  }

  return { isEligible: true, reason: 'READY' };
}

interface SendResult {
  success: boolean;
  isPaymentRequired?: boolean;
  slowmodeSeconds?: number;
  floodWaitSeconds?: number;
  error?: string;
}

type SendCallback = (chatId: string, text: string, linkUsed: string) => Promise<SendResult>;
type CheckMessagesCallback = (chatId: string, minRequired: number) => Promise<number>;

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

  private sentInRound = new Set<string>();

  private sleepResolve?: () => void;

  constructor(
    private readonly db: AutomationDatabase,
    private readonly sendCallback: SendCallback,
    private readonly checkMessagesCallback?: CheckMessagesCallback,
  ) {}

  getState(): Readonly<SchedulerState> {
    return { ...this.state };
  }

  start() {
    if (this.state.status === 'RUNNING') return;

    this.abortController = new AbortController();
    this.state.status = 'RUNNING';
    this.state.activeRound++;
    this.state.consecutiveSendsInRun = 0;
    this.sentInRound.clear();
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
    this.sentInRound.clear();
    this.state.sentInRoundCount = 0;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  resetRound() {
    this.sentInRound.clear();
    this.state.sentInRoundCount = 0;
  }

  skipPause() {
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

  private async runLoop(signal: AbortSignal) {
    try {
      while (!signal.aborted && this.state.status === 'RUNNING') {
        const config = this.db.getConfig();
        const serverNow = Math.floor(Date.now() / 1000);

        // 1. Sleep window check
        if (config.sleepWindowEnabled && isInsideSleepWindow(config.sleepWindowStart, config.sleepWindowEnd)) {
          this.state.status = 'SLEEP_WINDOW';
          await this.sleep(60_000, signal);
          this.state.status = 'RUNNING';
          continue;
        }

        // 2. Daily limit check
        const todaySent = this.db.getTodaySentCount(serverNow);
        if (todaySent >= config.dailyLimit) {
          this.state.lastRunError = `Daily limit reached (${todaySent}/${config.dailyLimit})`;
          await this.sleep(300_000, signal);
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

            await this.sleep(pauseSec * 1000, signal);
            this.state.consecutiveSendsInRun = 0;
            this.state.status = 'RUNNING';
            continue;
          }
        }

        // 4. Find eligible group in current round (excluding blocked chats and chats that charge stars)
        const allGroups = this.db.getAllGroupStates();
        const remainingInRound = allGroups.filter((g) => (
          !this.sentInRound.has(g.chatId)
          && g.status !== 'BLOCKED'
          && g.status !== 'STARS'
          && (g.starsCost || 0) === 0
        ));

        if (remainingInRound.length === 0 && allGroups.length > 0) {
          // All groups in this round were processed!
          if (config.mode === 'manual') {
            this.state.status = 'STOPPED';
            const snippet = `Rodada manual #${this.state.activeRound} concluída `
              + `(${this.sentInRound.size} grupos enviados).`;
            this.db.addLog({
              createdAt: serverNow,
              chatId: 'system',
              chatTitle: 'Sistema de Automação',
              messageSnippet: snippet,
              linkUsed: '',
              status: 'SUCCESS',
            });
            break;
          } else {
            this.state.status = 'WAITING_NEXT_ROUND';
            const snippet = `Rodada #${this.state.activeRound} concluída (${this.sentInRound.size} enviados). `
              + `Próxima rodada em ${config.roundIntervalMinutes} minutos.`;
            this.db.addLog({
              createdAt: serverNow,
              chatId: 'system',
              chatTitle: 'Sistema de Automação',
              messageSnippet: snippet,
              linkUsed: '',
              status: 'SUCCESS',
            });
            const pauseMs = Math.max(1, config.roundIntervalMinutes) * 60 * 1000;
            await this.sleep(pauseMs, signal);
            this.sentInRound.clear();
            this.state.sentInRoundCount = 0;
            this.state.activeRound++;
            this.state.status = 'RUNNING';
            continue;
          }
        }

        // Look for the next ready group among remainingInRound
        let eligibleGroup: GroupStateRecord | undefined;

        for (const g of remainingInRound) {
          let evalResult = evaluateGroupEligibility(g, config.minOtherMessages, serverNow);

          // If waiting for messages and we have a checker callback, query Telegram history for fresh count
          if (evalResult.reason === 'WAITING_MESSAGES' && this.checkMessagesCallback) {
            const verifiedCount = await this.checkMessagesCallback(g.chatId, config.minOtherMessages);
            if (verifiedCount >= config.minOtherMessages) {
              evalResult = { isEligible: true, reason: 'READY' };
            }
          }

          if (evalResult.isEligible) {
            eligibleGroup = g;
            break;
          }
        }

        if (!eligibleGroup) {
          // Groups exist in the round, but none are ready right now (slowmode or waiting for messages)
          // Wait 15 seconds before checking again. Do not stop the round!
          await this.sleep(15_000, signal);
          continue;
        }

        // 5. Compile and send message
        const campaign = this.db.getCampaign();
        if (!campaign.spintaxTemplate) {
          this.state.lastRunError = 'No campaign template configured';
          this.state.status = 'STOPPED';
          break;
        }

        this.state.currentChatId = eligibleGroup.chatId;
        this.state.currentChatTitle = eligibleGroup.title;

        // Pacing delay with jitter BEFORE sending
        const delayMs = calculateJitterDelayMs(config.minDelaySeconds, config.maxDelaySeconds);
        this.state.nextRunAt = Date.now() + delayMs;
        await this.sleep(delayMs, signal);

        // Execute send
        const { messageText, linkUsed } = compileSpunMessage(campaign.spintaxTemplate, campaign.links);
        const sendResult = await this.sendCallback(eligibleGroup.chatId, messageText, linkUsed);

        const timestamp = Math.floor(Date.now() / 1000);

        if (sendResult.success) {
          this.state.consecutiveFloodWaits = 0;
          this.state.consecutiveSendsInRun++;
          this.sentInRound.add(eligibleGroup.chatId);
          this.state.sentInRoundCount = this.sentInRound.size;
          this.db.resetGroupOtherMessages(eligibleGroup.chatId, timestamp);
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
            linkUsed,
            status: 'SUCCESS',
          });
        } else if (sendResult.isPaymentRequired) {
          // Group requires Stars payment - exclude from round and do NOT pause queue
          this.sentInRound.add(eligibleGroup.chatId);
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
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
            linkUsed,
            status: 'FLOOD_WAIT',
            details: `Flood wait: ${sendResult.floodWaitSeconds}s`,
          });

          // Circuit breaker: 2 consecutive flood waits = global 1 hour pause
          if (this.state.consecutiveFloodWaits >= 2) {
            this.state.status = 'CIRCUIT_BREAKER';
            this.state.lastRunError = 'Triggered Circuit Breaker: 2 consecutive flood waits. Pausing 1h.';
            await this.sleep(3600_000, signal);
            this.state.consecutiveFloodWaits = 0;
            this.state.status = 'RUNNING';
          } else {
            await this.sleep((sendResult.floodWaitSeconds + 30) * 1000, signal);
          }
        } else {
          const isPermError = /CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHAT_RESTRICTED/
            .test(sendResult.error || '');
          if (isPermError) {
            this.sentInRound.add(eligibleGroup.chatId);
          }
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
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
