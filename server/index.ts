import './polyfills';

import http from 'node:http';

import { createOrchestratorHandler } from './api/orchestratorRoutes';
import { startMemberTrackingLoop } from './automation/memberTracking';
import { AutomationScheduler } from './automation/scheduler';
import { TelegramRunner } from './automation/telegramRunner';
import { AutomationDatabase } from './db/database';
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
  ? OrchestratorWorkerClient.createSelf(db, `http://127.0.0.1:${PORT}`, WORKER_ID, process.env.WORKER_API_URL || '')
  : OrchestratorWorkerClient.fromEnv(db);
const scheduler = new AutomationScheduler(
  db,
  (chatId, text) => runner.sendMessage(chatId, text),
  (chatId, minRequired) => runner.checkOtherMessagesCount(chatId, minRequired),
  (chatId) => runner.probeChat(chatId),
  workerClient,
  () => (IS_MASTER ? coordinator.getWorker(WORKER_ID)?.metaTarget : undefined),
);

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

  workerClient?.startHeartbeatLoop(() => ({
    scheduler: scheduler.getState(),
    todaySent: db.getTodaySentCount(Math.floor(Date.now() / 1000)),
    isDegraded: workerClient.getIsDegraded(),
  }));
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  // eslint-disable-next-line no-console
  console.log('[Interdivu] Shutting down daemon...');
  workerClient?.stopHeartbeatLoop();
  scheduler.stop();
  await runner.stop();
  db.close();
  server.close(() => {
    process.exit(0);
  });
});
