import type http from 'node:http';

import type { AutomationScheduler } from '../automation/scheduler';
import type { TelegramRunner } from '../automation/telegramRunner';
import type { AutomationDatabase } from '../db/database';
import type { GrantRecord, OrchestratorCoordinator } from '../orchestrator/coordinator';

import { readJsonBody, sendError, sendJson } from './httpHelper';
import { createApiHandler as createAutomationApiHandler } from './routes';

export interface OrchestratorOptions {
  isMaster: boolean;
  workerId: string;
}

// Master-only control endpoints under /api/v1/orchestrator/. Not present at
// all on workers (404), so one image behaves as plain worker unless
// NODE_ROLE=master is set.
export function createOrchestratorHandler(
  db: AutomationDatabase,
  runner: TelegramRunner,
  scheduler: AutomationScheduler,
  coordinator: OrchestratorCoordinator,
  options: OrchestratorOptions,
) {
  const automationHandler = createAutomationApiHandler(db, runner, scheduler);

  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    if (!options.isMaster || !pathname.startsWith('/api/v1/orchestrator')) {
      return automationHandler(req, res);
    }

    const route = pathname.replace('/api/v1/orchestrator', '') || '/';

    // Orchestrator endpoints share the automation bearer token model.
    const apiToken = process.env.ORCHESTRATOR_TOKEN || process.env.AUTOMATION_API_TOKEN;
    if (apiToken && req.headers.authorization !== `Bearer ${apiToken}`) {
      sendError(res, 401, 'Unauthorized');
      return true;
    }

    const serverNow = Math.floor(Date.now() / 1000);

    try {
      if (route === '/info' && method === 'GET') {
        sendJson(res, 200, {
          isMaster: true,
          workerId: options.workerId,
          ...coordinator.getAggregatedStats(serverNow),
        });
        return true;
      }

      if (route === '/workers' && method === 'GET') {
        sendJson(res, 200, coordinator.listWorkers().map((worker) => ({
          ...worker,
          isAlive: serverNow - worker.lastHeartbeatAt <= 45,
        })));
        return true;
      }

      if (route === '/workers' && method === 'DELETE') {
        const workerId = url.searchParams.get('workerId');
        if (!workerId) {
          sendError(res, 400, 'workerId is required');
          return true;
        }
        coordinator.deleteWorker(workerId);
        sendJson(res, 200, { success: true });
        return true;
      }

      if (route === '/register' && method === 'POST') {
        const body = await readJsonBody<{
          workerId: string; apiUrl: string; groups?: string[]; version?: string;
        }>(req);
        if (!body.workerId || !body.apiUrl) {
          sendError(res, 400, 'workerId and apiUrl are required');
          return true;
        }
        coordinator.upsertWorker({
          workerId: body.workerId,
          apiUrl: body.apiUrl,
          groups: body.groups || [],
          version: body.version,
        });
        sendJson(res, 200, { success: true, serverNow });
        return true;
      }

      if (route === '/heartbeat' && method === 'POST') {
        const body = await readJsonBody<{
          workerId: string;
          apiUrl: string;
          groups?: string[];
          version?: string;
          status?: Record<string, unknown>;
        }>(req);
        if (!body.workerId || !body.apiUrl) {
          sendError(res, 400, 'workerId and apiUrl are required');
          return true;
        }
        coordinator.upsertWorker({
          workerId: body.workerId,
          apiUrl: body.apiUrl,
          groups: body.groups || [],
          version: body.version,
          statusSnapshot: body.status,
        });

        const config = db.getConfig();
        const campaign = db.getCampaign();
        coordinator.rebalanceMetaTargets(config.roundTargetSends, serverNow);

        const worker = coordinator.getWorker(body.workerId);
        sendJson(res, 200, {
          serverNow,
          // Desired-state pushed centrally so workers align automatically
          desiredConfig: {
            mode: config.mode,
            minDelaySeconds: config.minDelaySeconds,
            maxDelaySeconds: config.maxDelaySeconds,
            roundIntervalMinutes: config.roundIntervalMinutes,
            roundTargetSends: worker?.metaTarget ?? config.roundTargetSends,
            minOtherMessages: config.minOtherMessages,
            minResendIntervalMinutes: config.minResendIntervalMinutes,
            sleepWindowEnabled: config.sleepWindowEnabled,
            sleepWindowStart: config.sleepWindowStart,
            sleepWindowEnd: config.sleepWindowEnd,
            dailyLimit: config.dailyLimit,
            linkPreviewEnabled: config.linkPreviewEnabled,
            microPauseEnabled: config.microPauseEnabled,
            microPauseEveryMin: config.microPauseEveryMin,
            microPauseEveryMax: config.microPauseEveryMax,
            microPauseSeconds: config.microPauseSeconds,
            extractorEnabled: config.extractorEnabled,
          },
          desiredCampaign: {
            spintaxTemplate: campaign.spintaxTemplate,
            links: campaign.links,
          },
        });
        return true;
      }

      if (route === '/claim' && method === 'POST') {
        const body = await readJsonBody<{ workerId: string; chatId: string; chatTitle?: string }>(req);
        if (!body.workerId || !body.chatId) {
          sendError(res, 400, 'workerId and chatId are required');
          return true;
        }
        const title = body.chatTitle || db.getGroupState(body.chatId)?.title || body.chatId;
        const decision = coordinator.applyClaim(body.chatId, title, body.workerId, serverNow);
        sendJson(res, 200, decision);
        return true;
      }

      if (route === '/report' && method === 'POST') {
        const body = await readJsonBody<{
          workerId: string; chatId: string; result: GrantRecord['result'];
        }>(req);
        if (!body.workerId || !body.chatId || !body.result) {
          sendError(res, 400, 'workerId, chatId and result are required');
          return true;
        }
        const applied = coordinator.applyReport(body.workerId, body.chatId, body.result, serverNow);
        sendJson(res, 200, { success: applied });
        return true;
      }

      if (route === '/grants' && method === 'GET') {
        const limit = url.searchParams.get('limit');
        sendJson(res, 200, coordinator.listGrants(limit ? Number(limit) : 100));
        return true;
      }

      return automationHandler(req, res);
    } catch (err: any) {
      sendError(res, 500, `Orchestrator error: ${err.message}`);
      return true;
    }
  };
}
