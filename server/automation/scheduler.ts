import type { AutomationDatabase, GroupStateRecord } from '../db/database';

import { compileSpunMessage } from './spintax';

export interface SchedulerState {
  status: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'SLEEP_WINDOW' | 'CIRCUIT_BREAKER' | 'MICRO_PAUSE';
  currentChatId?: string;
  currentChatTitle?: string;
  nextRunAt?: number; // epoch ms
  sleepUntil?: number; // epoch ms
  activeRound: number;
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
): { isEligible: boolean; reason: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' } {
  if (group.status === 'BLOCKED') {
    return { isEligible: false, reason: 'BLOCKED' };
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

  // Check strict N other messages requirement
  if (group.otherMessagesCount < minOtherMessages) {
    return { isEligible: false, reason: 'WAITING_MESSAGES' };
  }

  return { isEligible: true, reason: 'READY' };
}

export class AutomationScheduler {
  private state: SchedulerState = {
    status: 'STOPPED',
    activeRound: 0,
    consecutiveFloodWaits: 0,
    consecutiveSendsInRun: 0,
  };

  private abortController?: AbortController;

  private loopPromise?: Promise<void>;

  constructor(
    private readonly db: AutomationDatabase,
    private readonly sendCallback: (chatId: string, text: string, linkUsed: string) => Promise<{ success: boolean; floodWaitSeconds?: number; error?: string }>,
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
    this.loopPromise = this.runLoop(this.abortController.signal);
  }

  stop() {
    this.state.status = 'STOPPED';
    this.state.currentChatId = undefined;
    this.state.currentChatTitle = undefined;
    this.state.nextRunAt = undefined;
    this.state.sleepUntil = undefined;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = undefined;
    }
  }

  private async sleep(ms: number, signal: AbortSignal): Promise<void> {
    this.state.sleepUntil = Date.now() + ms;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        this.state.sleepUntil = undefined;
        resolve();
      }, ms);

      const onAbort = () => {
        clearTimeout(timeout);
        this.state.sleepUntil = undefined;
        reject(new Error('Scheduler stopped'));
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

        // 3. Human micro-pause check (every 6 to 10 sends)
        const microPauseThreshold = 6 + (this.state.activeRound % 5);
        if (this.state.consecutiveSendsInRun >= microPauseThreshold) {
          this.state.status = 'MICRO_PAUSE';
          // 5 to 12 minutes human break
          const pauseSec = 300 + Math.floor(Math.random() * 420);
          await this.sleep(pauseSec * 1000, signal);
          this.state.consecutiveSendsInRun = 0;
          this.state.status = 'RUNNING';
          continue;
        }

        // 4. Find eligible group
        const allGroups = this.db.getAllGroupStates();
        const eligibleGroup = allGroups.find((g) => {
          const evalResult = evaluateGroupEligibility(g, config.minOtherMessages, serverNow);
          return evalResult.isEligible;
        });

        if (!eligibleGroup) {
          // If no groups are ready right now
          if (config.mode === 'manual') {
            // Manual round finished
            this.state.status = 'STOPPED';
            break;
          } else {
            // Continuous loop: wait before checking again
            await this.sleep(30_000, signal);
            continue;
          }
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
          this.db.resetGroupOtherMessages(eligibleGroup.chatId, timestamp);
          this.db.addLog({
            createdAt: timestamp,
            chatId: eligibleGroup.chatId,
            chatTitle: eligibleGroup.title,
            messageSnippet: messageText.slice(0, 100),
            linkUsed,
            status: 'SUCCESS',
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
