import type http from 'node:http';

import type { AutomationScheduler } from '../automation/scheduler';
import type { TelegramRunner } from '../automation/telegramRunner';
import type {
  AutomationDatabase,
  AutomationDbConfig,
} from '../db/database';
import type {
  GrantRecord,
  OrchestratorCommand,
  OrchestratorCommandAck,
  OrchestratorCoordinator,
} from '../orchestrator/coordinator';

import { OVERRIDEABLE_CONFIG_FIELDS, parseCampaignContentPayload } from '../db/database';
import { readJsonBody, sendError, sendJson } from './httpHelper';
import { createApiHandler as createAutomationApiHandler } from './routes';

export interface OrchestratorOptions {
  isMaster: boolean;
  workerId: string;
}

// Validates a sparse override patch against the whitelist; returns the first
// violation as an HTTP-ready message
function validateOverridePatch(patch: { set?: Record<string, unknown>; clear?: string[] }): string | undefined {
  for (const [field, value] of Object.entries(patch.set || {})) {
    const expectedType = OVERRIDEABLE_CONFIG_FIELDS[field as keyof AutomationDbConfig];
    if (!expectedType) {
      return `Field '${field}' is not globally overrideable`;
    }
    if (typeof value !== expectedType) {
      return `Field '${field}' expects a ${expectedType} value`;
    }
    if (field === 'mode' && value !== 'manual' && value !== 'continuous') {
      return 'Field \'mode\' must be \'manual\' or \'continuous\'';
    }
    if (expectedType === 'number' && !Number.isFinite(Number(value))) {
      return `Field '${field}' must be a finite number`;
    }
    if (expectedType === 'number' && Number(value) < 0) {
      return `Field '${field}' must not be negative`;
    }
    const isTimeField = field === 'sleepWindowStart' || field === 'sleepWindowEnd';
    if (isTimeField && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(value))) {
      return `Field '${field}' must be a valid HH:MM time`;
    }
  }
  for (const field of patch.clear || []) {
    if (!OVERRIDEABLE_CONFIG_FIELDS[field as keyof AutomationDbConfig]) {
      return `Field '${field}' is not globally overrideable`;
    }
  }
  return undefined;
}

// Computes the current global state for a given account: sparse overrides
// plus the rebalanced round-target share when a global target is defined.
// Without a global target every account keeps its own local round target
function resolveGlobalState(
  db: AutomationDatabase,
  coordinator: OrchestratorCoordinator,
  workerId: string,
  serverNow: number,
): { overrides: Partial<AutomationDbConfig>; roundTargetShare: number | undefined } {
  const overrides = db.listOverrides();
  if (typeof overrides.roundTargetSends === 'number') {
    coordinator.rebalanceMetaTargets(overrides.roundTargetSends, serverNow);
    return { overrides, roundTargetShare: coordinator.getWorker(workerId)?.metaTarget };
  }
  coordinator.clearMetaTargets();
  return { overrides, roundTargetShare: undefined };
}

// A takeover can spend long seconds connecting to Telegram (proxied
// accounts especially), so the direct push gets a generous deadline
const DIRECT_DELIVERY_TIMEOUT_MS = 45_000;

// Calls the worker's own automation API for start/stop so the action lands
// in ~1s instead of waiting for the next heartbeat; campaign copies ride
// the heartbeat channel because they carry a payload only its executor
// understands
async function deliverCommandDirect(
  apiUrl: string,
  endpoint: 'takeover' | 'release',
  authorization: string | undefined,
): Promise<string> {
  const res = await fetch(`${apiUrl.replace(/\/+$/, '')}/api/v1/automation/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authorization ? { Authorization: authorization } : {}),
    },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(DIRECT_DELIVERY_TIMEOUT_MS),
  });

  let message = '';
  try {
    message = (await res.json() as { message?: string }).message || '';
  } catch {
    // A non-JSON body is fine: the status code already told the story
  }
  if (!res.ok) {
    throw new Error(message || `HTTP ${res.status}`);
  }
  return message;
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

      if (route === '/overrides' && method === 'GET') {
        sendJson(res, 200, { overrides: db.listOverrides() });
        return true;
      }

      if (route === '/overrides' && method === 'PUT') {
        const body = await readJsonBody<{ set?: Record<string, unknown>; clear?: string[] }>(req);
        const validationError = validateOverridePatch(body);
        if (validationError) {
          sendError(res, 400, validationError);
          return true;
        }
        for (const [field, value] of Object.entries(body.set || {})) {
          db.setOverride(field, value as string | number | boolean);
        }
        for (const field of body.clear || []) {
          db.clearOverride(field);
        }
        const state = resolveGlobalState(db, coordinator, options.workerId, serverNow);
        // The master's own account consumes overrides through the same cache
        // the workers use, so refresh it right away instead of waiting a
        // heartbeat tick
        db.saveOrchestratorCache(state);
        sendJson(res, 200, { overrides: state.overrides });
        return true;
      }

      if (route === '/workers/command' && method === 'POST') {
        const body = await readJsonBody<{ workerId?: string; type?: string; payload?: unknown }>(req);
        if (!body.workerId || !body.type) {
          sendError(res, 400, 'workerId and type are required');
          return true;
        }
        const commandType = body.type as OrchestratorCommand['type'];
        if (commandType !== 'start' && commandType !== 'stop' && commandType !== 'campaign-copy') {
          sendError(res, 400, 'type must be \'start\', \'stop\' or \'campaign-copy\'');
          return true;
        }
        if (!coordinator.getWorker(body.workerId)) {
          sendError(res, 404, `Unknown worker '${body.workerId}'`);
          return true;
        }
        const payload = commandType === 'campaign-copy' ? parseCampaignContentPayload(body.payload) : undefined;
        if (commandType === 'campaign-copy' && !payload) {
          sendError(res, 400, 'Invalid campaign payload');
          return true;
        }
        const command: OrchestratorCommand = {
          id: `cmd-${serverNow}-${Math.random().toString(36).slice(2, 8)}`,
          type: commandType,
          payload,
          issuedAt: serverNow,
        };

        // Start/stop are pushed straight to the worker's daemon; any failure
        // (network, auth, rejection) falls back to the heartbeat channel,
        // where re-delivery is safe because the executors are idempotent
        const directEndpoint = commandType === 'start'
          ? 'takeover'
          : (commandType === 'stop' ? 'release' : undefined);
        if (directEndpoint) {
          const worker = coordinator.getWorker(body.workerId)!;
          try {
            const message = await deliverCommandDirect(
              worker.apiUrl,
              directEndpoint,
              req.headers.authorization,
            );
            const ack: OrchestratorCommandAck = {
              id: command.id,
              ok: true,
              message,
              at: Math.floor(Date.now() / 1000),
            };
            coordinator.ackCommand(body.workerId, ack);
            sendJson(res, 200, {
              success: true,
              command: { id: command.id, type: command.type },
              result: ack,
            });
            return true;
          } catch (err: any) {
            // eslint-disable-next-line no-console
            console.warn(
              `[Interdivu Orchestrator] Direct delivery of '${commandType}' to '${body.workerId}' failed `
              + `(${err?.message || err}); falling back to the heartbeat channel`,
            );
          }
        }
        coordinator.setPendingCommand(body.workerId, command);
        sendJson(res, 200, { success: true, command: { id: command.id, type: command.type } });
        return true;
      }

      // Fast ack path: the worker confirms a heartbeat-delivered command
      // right after executing it instead of waiting for the next heartbeat
      if (route === '/command-ack' && method === 'POST') {
        const body = await readJsonBody<{ workerId?: string; ack?: OrchestratorCommandAck }>(req);
        if (!body.workerId || !body.ack?.id) {
          sendError(res, 400, 'workerId and ack are required');
          return true;
        }
        if (!coordinator.getWorker(body.workerId)) {
          sendError(res, 404, `Unknown worker '${body.workerId}'`);
          return true;
        }
        coordinator.ackCommand(body.workerId, body.ack);
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
          commandAcks?: OrchestratorCommandAck[];
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

        // Acks are processed before the pending command is read so a command
        // is considered delivered on the very response that carries its ack
        for (const ack of body.commandAcks || []) {
          if (!ack?.id) continue;
          coordinator.ackCommand(body.workerId, {
            id: String(ack.id),
            ok: Boolean(ack.ok),
            message: ack.message === undefined ? undefined : String(ack.message).slice(0, 200),
            error: ack.error === undefined ? undefined : String(ack.error).slice(0, 200),
            at: serverNow,
          });
        }

        const { overrides, roundTargetShare } = resolveGlobalState(
          db, coordinator, body.workerId, serverNow,
        );
        const command = coordinator.takePendingCommand(body.workerId, serverNow);

        // Sparse global overrides (key always present — `{}` clears them) plus
        // the optional per-account share and pending command; undefined keys
        // are dropped by JSON serialization
        sendJson(res, 200, { serverNow, overrides, roundTargetShare, command });
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
