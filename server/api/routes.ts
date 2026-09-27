import type http from 'node:http';
import { URL } from 'node:url';

import type { AutomationScheduler } from '../automation/scheduler';
import type { TargetChatInfo, TelegramRunner } from '../automation/telegramRunner';
import type { AutomationDatabase } from '../db/database';

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

        const stats = {
          todaySent,
          dailyLimit: config.dailyLimit,
          totalGroups: groups.length,
          readyCount: groups.filter((g) => g.status === 'READY').length,
          waitingSlowmodeCount: groups.filter((g) => g.status === 'WAITING_SLOWMODE').length,
          waitingMessagesCount: groups.filter((g) => g.status === 'WAITING_MESSAGES').length,
          blockedCount: groups.filter((g) => g.status === 'BLOCKED').length,
        };

        sendJson(res, 200, {
          isRunning: schedulerState.status === 'RUNNING',
          status: schedulerState.status,
          isTelegramConnected: runner.getIsConnected(),
          currentChatId: schedulerState.currentChatId,
          currentChatTitle: schedulerState.currentChatTitle,
          nextRunAt: schedulerState.nextRunAt,
          sleepUntil: schedulerState.sleepUntil,
          activeRound: schedulerState.activeRound,
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
          targetChats: TargetChatInfo[];
        }>(req);

        if (!body.sessionData || !body.targetChats || !Array.isArray(body.targetChats)) {
          sendError(res, 400, 'Missing sessionData or targetChats array');
          return true;
        }

        // Save session to SQLite for persistence
        db.saveSession(JSON.stringify(body.sessionData));

        // Sync target groups in group_state
        body.targetChats.forEach((chat) => {
          const existing = db.getGroupState(chat.id);
          db.upsertGroupState({
            chatId: chat.id,
            title: chat.title,
            otherMessagesCount: existing ? existing.otherMessagesCount : 0,
            slowmodeSeconds: existing ? existing.slowmodeSeconds : 0,
            slowmodeNextSendDate: existing?.slowmodeNextSendDate,
            status: existing ? existing.status : 'READY',
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
        sendJson(res, 200, db.getAllGroupStates());
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

      sendError(res, 404, `Route /api/v1/automation/${route} not found`);
      return true;
    } catch (err: any) {
      sendError(res, 500, `Internal server error: ${err.message}`);
      return true;
    }
  };
}
