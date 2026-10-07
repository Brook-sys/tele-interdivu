import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AutomationScheduler } from '../automation/scheduler';
import { TelegramRunner } from '../automation/telegramRunner';
import { AutomationDatabase } from '../db/database';
import { OrchestratorCoordinator } from '../orchestrator/coordinator';
import { OrchestratorWorkerClient } from '../orchestrator/workerClient';
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
    // Destinations sync by index so workers map them to their own local ids
    expect(heartbeat.data.desiredCampaign.destinations).toEqual([]);
    expect(heartbeat.data.desiredCampaign.allLinks).toEqual([]);

    // Content with destinations arrives as index-based projections
    const campaignId = ctx.db.getCampaign().id;
    const destination = ctx.db.saveDestination({ campaignId, name: 'Grupo Sync', weight: 2 });
    ctx.db.saveCampaignLink({ campaignId, url: 'https://t.me/sync', destinationId: destination.id });

    const syncedHeartbeat = await api('heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        workerId: 'w1', apiUrl: 'http://w1.local', groups: ['-1'], status: { todaySent: 3 },
      }),
    });
    const desired = syncedHeartbeat.data.desiredCampaign;
    expect(desired.destinations).toEqual([{ name: 'Grupo Sync', weight: 2, isEnabled: true }]);
    expect(desired.allLinks).toEqual([
      { url: 'https://t.me/sync', isEnabled: true, destinationIndex: 0 },
    ]);

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

describe('Master self-registration and desired-state application', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  const TEST_HEARTBEAT_MS = 25;

  beforeAll(async () => {
    ctx = await startServer(true);
  });

  afterAll(() => {
    ctx.db.close();
    ctx.server.close();
  });

  it('self-registers the master without rewriting its own config, while real workers sync', async () => {
    // Master runs with a lower global target than the worker default (23) so
    // the desired-state push is observable
    ctx.db.updateConfig({ roundTargetSends: 7 });

    const selfDb = new AutomationDatabase(':memory:');
    const workerDb = new AutomationDatabase(':memory:');
    // Self must own a group for the claim path to be grantable
    selfDb.upsertGroupState({
      chatId: '-100',
      title: 'Grupo do Master',
      otherMessagesCount: 0,
      slowmodeSeconds: 0,
      starsCost: 0,
      status: 'READY',
    });

    const masterUrl = `http://127.0.0.1:${ctx.port}`;
    const selfClient = OrchestratorWorkerClient.createSelf(
      selfDb, masterUrl, 'master-self', 'http://master.local:8090', TEST_HEARTBEAT_MS,
    );
    const workerClient = new OrchestratorWorkerClient(
      workerDb, masterUrl, 'worker-2', 'http://worker.local:8091', undefined, true, TEST_HEARTBEAT_MS,
    );

    selfClient.startHeartbeatLoop(() => ({ todaySent: 0 }));
    workerClient.startHeartbeatLoop(() => ({ todaySent: 0 }));

    const reader = new OrchestratorCoordinator(ctx.db);
    await vi.waitFor(() => {
      expect(reader.getWorker('master-self')).toBeDefined();
      expect(reader.getWorker('worker-2')).toBeDefined();
    });

    // The real worker adopts its rebalanced share of the master's target
    await vi.waitFor(() => {
      expect(workerDb.getConfig().roundTargetSends).toBe(3);
    });

    // The self-registration never applies desired state back onto the master
    expect(selfDb.getConfig().roundTargetSends).toBe(23);

    // Rebalance splits the global target across the two alive accounts
    await vi.waitFor(() => {
      expect(reader.getWorker('master-self')?.metaTarget).toBe(4);
      expect(reader.getWorker('worker-2')?.metaTarget).toBe(3);
    });

    // The self-registered master claims send slots like any other worker
    const claim = await selfClient.claimSendSlot('-100', 'Grupo do Master');
    expect(claim?.granted).toBe(true);

    selfClient.stopHeartbeatLoop();
    workerClient.stopHeartbeatLoop();
    selfDb.close();
    workerDb.close();
  });
});
