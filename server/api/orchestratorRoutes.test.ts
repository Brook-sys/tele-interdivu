import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { OrchestratorCommand } from '../orchestrator/coordinator';

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

    // The old full config/campaign push is gone; only the sparse global
    // overrides key is always present
    const heartbeat = await api('heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w1', apiUrl: 'http://w1.local', groups: ['-1'], status: { todaySent: 3 } }),
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.data.overrides).toEqual({});
    expect('desiredConfig' in heartbeat.data).toBe(false);
    expect('desiredCampaign' in heartbeat.data).toBe(false);
    expect(heartbeat.data.roundTargetShare).toBeUndefined();
    expect(heartbeat.data.command).toBeUndefined();

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

  it('global overrides are defined, pushed and cleared from the panel API', async () => {
    const defined = await api('overrides', {
      method: 'PUT',
      body: JSON.stringify({ set: { minDelaySeconds: 90, roundTargetSends: 40 } }),
    });
    expect(defined.status).toBe(200);
    expect(defined.data.overrides).toEqual({ minDelaySeconds: 90, roundTargetSends: 40 });

    // A live worker receives the overrides plus its rebalanced share of the
    // global round target
    const heartbeat = await api('heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w1', apiUrl: 'http://w1.local', groups: ['-1'] }),
    });
    expect(heartbeat.data.overrides).toEqual({ minDelaySeconds: 90, roundTargetSends: 40 });
    expect(heartbeat.data.roundTargetShare).toBe(40);

    // Without a global target every account keeps its own local round target
    const cleared = await api('overrides', {
      method: 'PUT',
      body: JSON.stringify({ clear: ['roundTargetSends'] }),
    });
    expect(cleared.status).toBe(200);
    expect(cleared.data.overrides).toEqual({ minDelaySeconds: 90 });

    const afterClear = await api('heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w1', apiUrl: 'http://w1.local', groups: ['-1'] }),
    });
    expect(afterClear.data.roundTargetShare).toBeUndefined();

    // Unknown worker means no share either
    expect((await api('overrides')).data.overrides).toEqual({ minDelaySeconds: 90 });

    // Cleanup so the other flows in this file start from a clean slate
    await api('overrides', { method: 'PUT', body: JSON.stringify({ clear: ['minDelaySeconds'] }) });
  });

  it('rejects invalid override patches', async () => {
    const unknownField = await api('overrides', {
      method: 'PUT',
      body: JSON.stringify({ set: { notAField: 1 } }),
    });
    expect(unknownField.status).toBe(400);

    const wrongType = await api('overrides', {
      method: 'PUT',
      body: JSON.stringify({ set: { minDelaySeconds: 'fast' } }),
    });
    expect(wrongType.status).toBe(400);

    const badMode = await api('overrides', {
      method: 'PUT',
      body: JSON.stringify({ set: { mode: 'turbo' } }),
    });
    expect(badMode.status).toBe(400);

    const negative = await api('overrides', {
      method: 'PUT',
      body: JSON.stringify({ set: { dailyLimit: -1 } }),
    });
    expect(negative.status).toBe(400);

    const badWindow = await api('overrides', {
      method: 'PUT',
      body: JSON.stringify({ set: { sleepWindowStart: '25:99' } }),
    });
    expect(badWindow.status).toBe(400);

    const badClear = await api('overrides', {
      method: 'PUT',
      body: JSON.stringify({ clear: ['nope'] }),
    });
    expect(badClear.status).toBe(400);
  });

  it('delivers commands through heartbeats and records the ack', async () => {
    await api('register', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w9', apiUrl: 'http://w9.local', groups: ['-2'] }),
    });

    const unknownWorker = await api('workers/command', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'ghost', type: 'start' }),
    });
    expect(unknownWorker.status).toBe(404);

    const badType = await api('workers/command', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w9', type: 'explode' }),
    });
    expect(badType.status).toBe(400);

    const badPayload = await api('workers/command', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w9', type: 'campaign-copy', payload: { nope: true } }),
    });
    expect(badPayload.status).toBe(400);

    const validCopy = await api('workers/command', {
      method: 'POST',
      body: JSON.stringify({
        workerId: 'w9',
        type: 'campaign-copy',
        payload: {
          templates: [{ title: 'P', content: 'oi {link}' }],
          links: [{ url: 'https://t.me/x', isEnabled: true }],
          destinations: [{ name: 'D1', weight: 1, isEnabled: true }],
        },
      }),
    });
    expect(validCopy.status).toBe(200);
    const commandId = validCopy.data.command.id;

    // The next heartbeat delivers the pending command exactly once
    const delivered = await api('heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w9', apiUrl: 'http://w9.local', groups: ['-2'] }),
    });
    expect(delivered.data.command).toMatchObject({ id: commandId, type: 'campaign-copy' });

    // The ack on the following heartbeat closes the command
    const acked = await api('heartbeat', {
      method: 'POST',
      body: JSON.stringify({
        workerId: 'w9',
        apiUrl: 'http://w9.local',
        groups: ['-2'],
        commandAcks: [{ id: commandId, ok: true, message: 'applied' }],
      }),
    });
    expect(acked.data.command).toBeUndefined();

    const workers = await api('workers');
    const w9 = (workers.data as any[]).find((worker) => worker.workerId === 'w9');
    expect(w9.pendingCommand).toBeUndefined();
    expect(w9.lastCommandAck).toMatchObject({ id: commandId, ok: true });

    // A stale command never fires when the account comes back online
    const start = await api('workers/command', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w9', type: 'start' }),
    });
    expect(start.status).toBe(200);
    ctx.db.rawDb().prepare(
      `UPDATE orchestrator_workers SET pending_command_json = ?
       WHERE worker_id = 'w9'`,
    ).run(JSON.stringify({ ...start.data.command, issuedAt: Math.floor(Date.now() / 1000) - 600 }));

    const expired = await api('heartbeat', {
      method: 'POST',
      body: JSON.stringify({ workerId: 'w9', apiUrl: 'http://w9.local', groups: ['-2'] }),
    });
    expect(expired.data.command).toBeUndefined();

    const workersAfterExpiry = await api('workers');
    const w9After = (workersAfterExpiry.data as any[]).find((worker) => worker.workerId === 'w9');
    expect(w9After.lastCommandAck).toMatchObject({ ok: false, error: 'Command expired before execution' });
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

describe('Master self-registration, override cache and command execution', () => {
  let ctx: Awaited<ReturnType<typeof startServer>>;
  const TEST_HEARTBEAT_MS = 25;

  beforeAll(async () => {
    ctx = await startServer(true);
  });

  afterAll(() => {
    ctx.db.close();
    ctx.server.close();
  });

  it('keeps local configs pristine while global overrides and shares drive the effective config', async () => {
    // Define a global rhythm plus a global round target (7 → 4/3 across the
    // two accounts that register below)
    const res = await fetch(`http://127.0.0.1:${ctx.port}/api/v1/orchestrator/overrides`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ set: { roundTargetSends: 7, minDelaySeconds: 90 } }),
    });
    expect(res.status).toBe(200);

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
    const executedCommands: OrchestratorCommand[] = [];
    const selfClient = OrchestratorWorkerClient.createSelf(
      selfDb, masterUrl, 'master-self', 'http://master.local:8090', TEST_HEARTBEAT_MS,
    );
    const workerClient = new OrchestratorWorkerClient(
      workerDb,
      masterUrl,
      'worker-2',
      'http://worker.local:8091',
      undefined,
      (command) => {
        executedCommands.push(command);
        return Promise.resolve({ ok: true, message: 'handled' });
      },
      TEST_HEARTBEAT_MS,
    );

    selfClient.startHeartbeatLoop(() => ({ todaySent: 0 }));
    workerClient.startHeartbeatLoop(() => ({ todaySent: 0 }));

    const reader = new OrchestratorCoordinator(ctx.db);
    await vi.waitFor(() => {
      expect(reader.getWorker('master-self')).toBeDefined();
      expect(reader.getWorker('worker-2')).toBeDefined();
    });

    // The worker caches the pushed overrides and its rebalanced share; the
    // local config table is never touched (23 is the seeded default)
    await vi.waitFor(() => {
      expect(workerDb.getEffectiveConfig().roundTargetSends).toBe(3);
      expect(workerDb.getEffectiveConfig().minDelaySeconds).toBe(90);
    });
    expect(workerDb.getConfig().roundTargetSends).toBe(23);
    expect(workerDb.getConfig().minDelaySeconds).not.toBe(90);
    expect(workerDb.getOverriddenFields()).toEqual(
      expect.arrayContaining(['minDelaySeconds', 'roundTargetSends']),
    );

    // The self-registration consumes the same protocol: its own share drives
    // its effective config while its local values stay intact
    await vi.waitFor(() => {
      expect(selfDb.getEffectiveConfig().roundTargetSends).toBe(4);
      expect(selfDb.getEffectiveConfig().minDelaySeconds).toBe(90);
    });
    expect(selfDb.getConfig().roundTargetSends).toBe(23);
    expect(selfClient.getIsDegraded()).toBe(false);

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

    // The cached overrides survive a degraded period: effective config keeps
    // honoring the global rhythm even with the master unreachable
    expect(workerDb.getEffectiveConfig().minDelaySeconds).toBe(90);
    expect(workerDb.getEffectiveConfig().roundTargetSends).toBe(3);

    selfDb.close();
    workerDb.close();
  });

  it('executes a start command issued from the panel and acks it end-to-end', async () => {
    const workerDb = new AutomationDatabase(':memory:');
    const masterUrl = `http://127.0.0.1:${ctx.port}`;
    const executedCommands: OrchestratorCommand[] = [];
    const workerClient = new OrchestratorWorkerClient(
      workerDb,
      masterUrl,
      'worker-3',
      'http://worker.local:8093',
      undefined,
      (command) => {
        executedCommands.push(command);
        return Promise.resolve({ ok: true, message: 'started' });
      },
      TEST_HEARTBEAT_MS,
    );
    workerClient.startHeartbeatLoop(() => ({ todaySent: 0 }));

    await vi.waitFor(() => {
      expect(new OrchestratorCoordinator(ctx.db).getWorker('worker-3')).toBeDefined();
    });

    const issued = await fetch(`http://127.0.0.1:${ctx.port}/api/v1/orchestrator/workers/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workerId: 'worker-3', type: 'start' }),
    });
    const issuedData = await issued.json() as { command: { id: string } };
    expect(issued.status).toBe(200);

    // The worker executes the pending command on its next heartbeat
    await vi.waitFor(() => {
      expect(executedCommands.map((command) => command.type)).toContain('start');
    });
    expect(executedCommands[0].id).toBe(issuedData.command.id);

    // ...and the ack on the following heartbeat closes it on the master
    await vi.waitFor(async () => {
      const workersRes = await fetch(`http://127.0.0.1:${ctx.port}/api/v1/orchestrator/workers`);
      const workers = await workersRes.json() as any[];
      const worker = workers.find((entry) => entry.workerId === 'worker-3');
      expect(worker.pendingCommand).toBeUndefined();
      expect(worker.lastCommandAck).toMatchObject({ id: issuedData.command.id, ok: true });
    });

    workerClient.stopHeartbeatLoop();
    workerDb.close();
  });
});
