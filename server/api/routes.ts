import type http from 'node:http';
import { URL } from 'node:url';

import type { TargetChatInfo, TelegramRunner } from '../automation/telegramRunner';
import type { AutomationDatabase } from '../db/database';

import { type AutomationScheduler, evaluateGroupEligibility } from '../automation/scheduler';
import { compileSpunMessage, validateSpintaxSyntax } from '../automation/spintax';
import { readJsonBody, sendError, sendJson } from './httpHelper';

export function createApiHandler(
  db: AutomationDatabase,
  runner: TelegramRunner,
  scheduler: AutomationScheduler,
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return true;
    }

    if (!pathname.startsWith('/api/v1/automation/')) {
      return false;
    }

    const route = pathname.replace('/api/v1/automation/', '');

    try {
      // 1. GET status
      if (route === 'status' && method === 'GET') {
        const schedulerState = scheduler.getState();
        const config = db.getConfig();
        const campaign = db.getCampaign();
        const serverNow = Math.floor(Date.now() / 1000);
        const todaySent = db.getTodaySentCount(serverNow);
        const groups = db.getAllGroupStates();

        let readyCount = 0;
        let waitingSlowmodeCount = 0;
        let waitingMessagesCount = 0;
        let blockedCount = 0;
        let starsCount = 0;

        for (const g of groups) {
          const evalResult = evaluateGroupEligibility(g, config.minOtherMessages, serverNow);
          if (evalResult.reason === 'READY') readyCount++;
          else if (evalResult.reason === 'WAITING_SLOWMODE') waitingSlowmodeCount++;
          else if (evalResult.reason === 'WAITING_MESSAGES') waitingMessagesCount++;
          else if (evalResult.reason === 'STARS') starsCount++;
          else if (evalResult.reason === 'BLOCKED') blockedCount++;
        }

        const validGroupsCount = groups.filter((g) => (
          g.status !== 'BLOCKED'
          && g.status !== 'STARS'
          && (g.starsCost || 0) === 0
        )).length;

        const stats = {
          todaySent,
          dailyLimit: config.dailyLimit,
          totalGroups: validGroupsCount,
          readyCount,
          waitingSlowmodeCount,
          waitingMessagesCount,
          blockedCount,
          starsCount,
        };

        const isRunning = schedulerState.status === 'RUNNING'
          || schedulerState.status === 'WAITING_NEXT_ROUND'
          || schedulerState.status === 'MICRO_PAUSE'
          || schedulerState.status === 'SLEEP_WINDOW'
          || schedulerState.status === 'CIRCUIT_BREAKER';

        sendJson(res, 200, {
          isRunning,
          status: schedulerState.status,
          isTelegramConnected: runner.getIsConnected(),
          currentChatId: schedulerState.currentChatId,
          currentChatTitle: schedulerState.currentChatTitle,
          nextRunAt: schedulerState.nextRunAt,
          sleepUntil: schedulerState.sleepUntil,
          activeRound: schedulerState.activeRound,
          sentInRoundCount: schedulerState.sentInRoundCount,
          lastError: schedulerState.lastRunError,
          stats,
          config,
          campaign,
        });
        return true;
      }

      // 2. POST takeover (Frontend hands over session and targets to daemon)
      if (route === 'takeover' && method === 'POST') {
        const body = await readJsonBody<{
          sessionData: any;
          targetChats: (TargetChatInfo & {
            slowmodeSeconds?: number;
            slowmodeNextSendDate?: number;
            lastSentAt?: number;
            starsCost?: number;
            status?: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' | 'STARS' | 'SENT';
          })[];
        }>(req);

        if (!body.sessionData || !body.targetChats || !Array.isArray(body.targetChats)) {
          sendError(res, 400, 'Missing sessionData or targetChats array');
          return true;
        }

        // Save session to SQLite for persistence
        db.saveSession(JSON.stringify(body.sessionData));

        // Sync target groups in group_state — removes any old/deleted chats
        const validChatIds = body.targetChats.map((c) => c.id);
        db.syncTargetGroups(validChatIds);

        body.targetChats.forEach((chat) => {
          const existing = db.getGroupState(chat.id);
          const slowmodeSeconds = chat.slowmodeSeconds !== undefined
            ? chat.slowmodeSeconds
            : (existing?.slowmodeSeconds ?? 0);
          const slowmodeNextSendDate = chat.slowmodeNextSendDate !== undefined
            ? chat.slowmodeNextSendDate
            : existing?.slowmodeNextSendDate;
          const lastSentAt = chat.lastSentAt !== undefined ? chat.lastSentAt : existing?.lastSentAt;
          const starsCost = chat.starsCost !== undefined ? chat.starsCost : (existing?.starsCost ?? 0);
          const status = (starsCost > 0 || chat.status === 'STARS')
            ? 'STARS'
            : (chat.status || (existing?.status ?? 'READY'));

          db.upsertGroupState({
            chatId: chat.id,
            title: chat.title,
            otherMessagesCount: existing ? existing.otherMessagesCount : 0,
            slowmodeSeconds,
            slowmodeNextSendDate,
            starsCost,
            lastSentAt,
            status,
          });
        });

        // Start runner with Telegram session
        await runner.start(body.sessionData, body.targetChats);

        // Start scheduler loop
        scheduler.start();

        sendJson(res, 200, { success: true, message: 'Automation takeover successful' });
        return true;
      }

      // 3. POST release (User pauses/stops automation, reclaiming session for browser)
      if (route === 'release' && method === 'POST') {
        scheduler.stop();
        await runner.stop();

        sendJson(res, 200, { success: true, message: 'Automation stopped and session released' });
        return true;
      }

      // 4. GET & POST config
      if (route === 'config') {
        if (method === 'GET') {
          sendJson(res, 200, db.getConfig());
          return true;
        }
        if (method === 'POST') {
          const patch = await readJsonBody<any>(req);
          const updated = db.updateConfig(patch);
          sendJson(res, 200, updated);
          return true;
        }
      }

      // 5. GET & POST campaign
      if (route === 'campaign') {
        if (method === 'GET') {
          sendJson(res, 200, db.getCampaign());
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody<{ spintaxTemplate: string; links: string[] }>(req);
          const validation = validateSpintaxSyntax(body.spintaxTemplate || '');
          if (!validation.isValid) {
            sendError(res, 400, `Spintax syntax error: ${validation.error}`);
            return true;
          }
          const saved = db.saveCampaign(body.spintaxTemplate || '', body.links || []);
          sendJson(res, 200, saved);
          return true;
        }
      }

      // 6. GET groups
      if (route === 'groups' && method === 'GET') {
        const config = db.getConfig();
        const serverNow = Math.floor(Date.now() / 1000);
        const groups = db.getAllGroupStates();

        const evaluatedGroups = groups.map((g) => {
          const evalResult = evaluateGroupEligibility(g, config.minOtherMessages, serverNow);
          return {
            ...g,
            status: evalResult.reason,
          };
        });

        sendJson(res, 200, evaluatedGroups);
        return true;
      }

      // 7. GET logs
      if (route === 'logs' && method === 'GET') {
        const limitStr = parsedUrl.searchParams.get('limit');
        const limit = limitStr ? Math.min(100, Math.max(1, Number(limitStr))) : 50;
        sendJson(res, 200, db.getRecentLogs(limit));
        return true;
      }

      // 8. POST test-spintax
      if (route === 'test-spintax' && method === 'POST') {
        const body = await readJsonBody<{ template: string; links: string[] }>(req);
        const validation = validateSpintaxSyntax(body.template || '');
        if (!validation.isValid) {
          sendError(res, 400, `Spintax syntax error: ${validation.error}`);
          return true;
        }

        const previews = [];
        for (let i = 0; i < 5; i++) {
          previews.push(compileSpunMessage(body.template || '', body.links || []));
        }

        sendJson(res, 200, { previews });
        return true;
      }

      // 9. POST reset-round
      if (route === 'reset-round' && method === 'POST') {
        scheduler.resetRound();
        sendJson(res, 200, { success: true, message: 'Round counters reset' });
        return true;
      }

      // 10. POST skip-pause (Wakes up scheduler from micro-pause or round sleep)
      if (route === 'skip-pause' && method === 'POST') {
        scheduler.skipPause();
        sendJson(res, 200, { success: true, message: 'Pausa pulada com sucesso' });
        return true;
      }

      // 11. GET debug (Comprehensive diagnostics)
      if (route === 'debug' && method === 'GET') {
        const schedulerState = scheduler.getState();
        const config = db.getConfig();
        const serverNow = Math.floor(Date.now() / 1000);
        const groups = db.getAllGroupStates();
        const runnerStats = runner.getStats();

        const evaluatedGroups = groups.map((g) => {
          const evalResult = evaluateGroupEligibility(g, config.minOtherMessages, serverNow);
          const slowmodeRemaining = g.slowmodeNextSendDate && g.slowmodeNextSendDate > serverNow
            ? g.slowmodeNextSendDate - serverNow : 0;
          return {
            chatId: g.chatId,
            title: g.title,
            status: g.status,
            evaluatedReason: evalResult.reason,
            isEligible: evalResult.isEligible,
            otherMessagesCount: g.otherMessagesCount,
            minOtherMessagesRequired: config.minOtherMessages,
            slowmodeSeconds: g.slowmodeSeconds,
            slowmodeRemaining,
            starsCost: g.starsCost,
            lastSentAt: g.lastSentAt ? new Date(g.lastSentAt * 1000).toISOString() : undefined,
            lastError: g.lastError,
          };
        });

        const sleepRemainingSeconds = schedulerState.sleepUntil && schedulerState.sleepUntil > Date.now()
          ? Math.round((schedulerState.sleepUntil - Date.now()) / 1000) : 0;
        const nextRunRemainingSeconds = schedulerState.nextRunAt && schedulerState.nextRunAt > Date.now()
          ? Math.round((schedulerState.nextRunAt - Date.now()) / 1000) : 0;

        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          scheduler: {
            ...schedulerState,
            sleepRemainingSeconds,
            nextRunRemainingSeconds,
          },
          connection: runnerStats,
          config,
          groups: evaluatedGroups,
          system: {
            uptime: Math.round(process.uptime()),
            memory: process.memoryUsage(),
            nodeVersion: process.version,
            isProxyConfigured: Boolean(process.env.PROXY_URL),
          },
        });
        return true;
      }

      sendError(res, 404, `Route /api/v1/automation/${route} not found`);
      return true;
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error(`[Automation API] ${method} ${pathname} failed:`, err.stack || err.message);
      sendError(res, 500, `Internal server error (${route}): ${err.message}`);
      return true;
    }
  };
}
