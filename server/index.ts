import './polyfills';

import http from 'node:http';

import { createApiHandler } from './api/routes';
import { AutomationScheduler } from './automation/scheduler';
import { TelegramRunner } from './automation/telegramRunner';
import { AutomationDatabase } from './db/database';
import { handleWsRelay } from './proxy/wsRelay';

const PORT = Number(process.env.AUTOMATION_PORT) || 3000;
const PROXY_URL = process.env.PROXY_URL;

const db = new AutomationDatabase();
const runner = new TelegramRunner(db, PORT);
const scheduler = new AutomationScheduler(
  db,
  (chatId, text) => runner.sendMessage(chatId, text),
  (chatId, minRequired) => runner.checkOtherMessagesCount(chatId, minRequired),
);

const apiHandler = createApiHandler(db, runner, scheduler);

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
  console.log(`[Interdivu Automation Daemon] Listening on 127.0.0.1:${PORT}`);
  if (PROXY_URL) {
    // eslint-disable-next-line no-console
    console.log(`[Interdivu Proxy] Active PROXY_URL: ${PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
  }
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  // eslint-disable-next-line no-console
  console.log('[Interdivu] Shutting down daemon...');
  scheduler.stop();
  await runner.stop();
  db.close();
  server.close(() => {
    process.exit(0);
  });
});
