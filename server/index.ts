import './polyfills';

import http from 'node:http';

import type { OrchestratorCommand, OrchestratorCommandResult } from './orchestrator/coordinator';

import { createOrchestratorHandler } from './api/orchestratorRoutes';
import { startAutomationFromSavedState, stopAutomation } from './api/routes';
import { startMemberTrackingLoop } from './automation/memberTracking';
import { AutomationScheduler } from './automation/scheduler';
import { TelegramRunner } from './automation/telegramRunner';
import { AutomationDatabase, parseCampaignContentPayload } from './db/database';
import { OrchestratorCoordinator } from './orchestrator/coordinator';
import { OrchestratorWorkerClient } from './orchestrator/workerClient';
import { getProxyUrlFormatError } from './proxy/tunnel';
import { handleWsRelay } from './proxy/wsRelay';

const PORT = Number(process.env.AUTOMATION_PORT) || 3000;
const PROXY_URL = process.env.PROXY_URL;
const NODE_ROLE = process.env.NODE_ROLE || 'worker';
const IS_MASTER = NODE_ROLE === 'master';
const WORKER_ID = process.env.WORKER_ID || process.env.HOSTNAME || (IS_MASTER ? 'master' : 'worker');

const proxyUrlError = getProxyUrlFormatError(PROXY_URL);
if (proxyUrlError) {
  // eslint-disable-next-line no-console
  console.error(`[Interdivu Proxy] PROXY_URL is unusable: ${proxyUrlError}`);
  // eslint-disable-next-line no-console
  console.error('[Interdivu Proxy] Every MTProto connection routes through it — fix before starting the automation');
}

const db = new AutomationDatabase();
const runner = new TelegramRunner(db, PORT);
const coordinator = new OrchestratorCoordinator(db);
// Workers register against MASTER_URL; a master with no MASTER_URL registers
// its own account through the local daemon API instead, so its sends are
// coordinated under the same global rules as every other account
const workerClient = !process.env.MASTER_URL && IS_MASTER
  ? OrchestratorWorkerClient.createSelf(
    db, `http://127.0.0.1:${PORT}`, WORKER_ID, process.env.WORKER_API_URL || '', undefined, handleOrchestratorCommand,
  )
  : OrchestratorWorkerClient.fromEnv(db, handleOrchestratorCommand);
const scheduler = new AutomationScheduler(
  db,
  (chatId, text) => runner.sendMessage(chatId, text),
  (chatId, minRequired) => runner.checkOtherMessagesCount(chatId, minRequired),
  (chatId) => runner.probeChat(chatId),
  workerClient,
);

// Executes commands issued from the orchestration panel through the heartbeat
// channel. Every branch is idempotent, so re-delivery after a lost ack is
// harmless. Commands only arrive once the heartbeat loop starts, long after
// the consts above are initialized
async function handleOrchestratorCommand(command: OrchestratorCommand): Promise<OrchestratorCommandResult> {
  if (command.type === 'start') {
    if (scheduler.getState().status !== 'STOPPED') {
      return { ok: true, message: 'Automation was already running' };
    }
    const result = await startAutomationFromSavedState(db, runner, scheduler);
    return result.success
      ? { ok: true, message: `Started with ${result.groupsCount} groups` }
      : { ok: false, error: result.message };
  }

  if (command.type === 'stop') {
    if (scheduler.getState().status === 'STOPPED') {
      return { ok: true, message: 'Automation was already stopped' };
    }
    await stopAutomation(db, runner, scheduler);
    return { ok: true, message: 'Automation stopped' };
  }

  if (command.type === 'campaign-copy') {
    const payload = parseCampaignContentPayload(command.payload);
    if (!payload) {
      return { ok: false, error: 'Invalid campaign payload' };
    }
    db.replaceCampaignContent(
      db.getCampaign().id, payload.templates, payload.links, payload.destinations,
    );
    return {
      ok: true,
      message: `Campaign applied: ${payload.templates.length} templates, ${payload.links.length} links`,
    };
  }

  return { ok: false, error: `Unknown command type: ${String(command.type)}` };
}

// Opt-in periodic member tracking for promoted links (read-only, paced)
startMemberTrackingLoop(
  db,
  (url) => runner.resolveCampaignLink(url),
  () => runner.getIsConnected(),
);

const apiHandler = createOrchestratorHandler(db, runner, scheduler, coordinator, {
  isMaster: IS_MASTER,
  workerId: WORKER_ID,
});

const server = http.createServer(async (req, res) => {
  const handled = await apiHandler(req, res);
  if (!handled) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found\n');
  }
});

server.on('upgrade', (req, clientSocket, head) => {
  const url = req.url || '';
  if (url.startsWith('/apiws_proxy')) {
    handleWsRelay(req, clientSocket, head, PROXY_URL);
  } else {
    clientSocket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    clientSocket.destroy();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[Interdivu Automation Daemon] Listening on 127.0.0.1:${PORT} (role: ${NODE_ROLE})`);
  if (PROXY_URL) {
    // eslint-disable-next-line no-console
    console.log(`[Interdivu Proxy] Active PROXY_URL: ${PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
  }

  if (workerClient) {
    const masterTarget = !process.env.MASTER_URL && IS_MASTER
      ? `self (${WORKER_ID})`
      : String(process.env.MASTER_URL);
    // eslint-disable-next-line no-console
    console.log(
      `[Interdivu Orchestrator] workerId='${WORKER_ID}' role=${NODE_ROLE} master=${masterTarget}`,
    );
  } else {
    const hint = 'standalone (set MASTER_URL + WORKER_API_URL to orchestrate)';
    // eslint-disable-next-line no-console
    console.log(`[Interdivu Orchestrator] workerId='${WORKER_ID}' role=${NODE_ROLE} — ${hint}`);
  }

  workerClient?.startHeartbeatLoop(() => {
    const effectiveConfig = db.getEffectiveConfig();
    return {
      scheduler: scheduler.getState(),
      todaySent: db.getTodaySentCount(Math.floor(Date.now() / 1000)),
      isDegraded: workerClient.getIsDegraded(),
      account: runner.getAccountInfo(),
      // Read-only digest of the effective rhythm so the panel can compare
      // accounts without opening each one's settings
      configDigest: {
        mode: effectiveConfig.mode,
        minDelaySeconds: effectiveConfig.minDelaySeconds,
        maxDelaySeconds: effectiveConfig.maxDelaySeconds,
        roundIntervalMinutes: effectiveConfig.roundIntervalMinutes,
        roundTargetSends: effectiveConfig.roundTargetSends,
        minOtherMessages: effectiveConfig.minOtherMessages,
        minResendIntervalMinutes: effectiveConfig.minResendIntervalMinutes,
        dailyLimit: effectiveConfig.dailyLimit,
        sleepWindowEnabled: effectiveConfig.sleepWindowEnabled,
        sleepWindowStart: effectiveConfig.sleepWindowStart,
        sleepWindowEnd: effectiveConfig.sleepWindowEnd,
      },
      overriddenFields: db.getOverriddenFields(),
    };
  });
});

// Graceful shutdown: Docker sends SIGTERM on stop/recreate and SIGKILLs ~10s
// later. Releasing the Telegram socket here is the one step that must not
// die abruptly — a killed connection makes the server hold the auth key "in
// use", and reconnecting inside that window destroys the session
// (AUTH_KEY_DUPLICATED, postmortem 72). The reconnect cooldown in the API
// layer covers everything this handler cannot finish in time
function shutdown() {
  // eslint-disable-next-line no-console
  console.log('[Interdivu] Shutting down daemon...');
  // Safety net for anything below hanging: never let Docker's SIGKILL be the
  // thing that ends the process
  const forceExitTimer = setTimeout(() => process.exit(0), 3000);
  forceExitTimer.unref();
  try {
    workerClient?.stopHeartbeatLoop();
  } catch {
    // Best-effort shutdown
  }
  try {
    scheduler.stop();
  } catch {
    // Best-effort shutdown
  }
  void runner.stop().then(() => {
    try {
      db.close();
    } catch {
      // Best-effort shutdown
    }
    // Keep-alive HTTP connections keep server.close pending forever, so the
    // process exits on its own instead of waiting for them to drain
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
