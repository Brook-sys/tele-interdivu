import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationScheduler } from '../automation/scheduler';
import { TelegramRunner } from '../automation/telegramRunner';
import { AutomationDatabase } from '../db/database';
import { OrchestratorCoordinator } from '../orchestrator/coordinator';
import { createOrchestratorHandler } from './orchestratorRoutes';

async function startServer(isMaster: boolean) {
  const db = new AutomationDatabase(':memory:');
  const runner = new TelegramRunner(db);
  const scheduler = new AutomationScheduler(db, () => Promise.resolve({ success: true }));
  const coordinator = new OrchestratorCoordinator(db);
  const handler = createOrchestratorHandler(db, runner, scheduler, coordinator, {
    isMaster,
    workerId: 'master-1',
  });
  const server = http.createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  return { db, server, port: (server.address() as any).port };
}

describe('Orchestrator REST API', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    ctx = await startServer(true);
  });

  afterAll(() => {
    ctx.db.close();
    ctx.server.close();
  });

  async function api(path: string, options: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/v1/orchestrator/${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    return { status: res.status, data: await res.json() };
  }

  it('register + heartbeat + claim + report flow works end-to-end', async () => {
    const registered = await api('register', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w1', apiUrl: 'http://w1.local', groups: ['-1'] }),
    });
    expect(registered.status).toBe(200);

    const heartbeat = await api('heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w1', apiUrl: 'http://w1.local', groups: ['-1'], status: { todaySent: 3 } }),
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.data.desiredConfig).toBeDefined();
    expect(heartbeat.data.desiredCampaign).toBeDefined();

    const claim = await api('claim', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w1', chatId: '-1', chatTitle: 'Grupo A' }),
    });
    expect(claim.status).toBe(200);
    expect(claim.data.granted).toBe(true);

    const report = await api('report', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w1', chatId: '-1', result: 'success' }),
    });
    expect(report.status).toBe(200);
    expect(report.data.success).toBe(true);

    const info = await api('info');
    expect(info.data.aliveWorkers).toBe(1);
    expect(info.data.totalTodaySent).toBe(3);

    const grants = await api('grants');
    expect(grants.data).toHaveLength(1);
    expect(grants.data[0].result).toBe('success');
  });

  it('info is not exposed on workers', async () => {
    const workerCtx = await startServer(false);
    try {
      const res = await fetch(`http://127.0.0.1:${workerCtx.port}/api/v1/orchestrator/info`);
      expect(res.status).toBe(404);
    } finally {
      workerCtx.db.close();
      workerCtx.server.close();
    }
  });
});
