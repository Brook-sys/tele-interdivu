import { describe, expect, it } from 'vitest';

import { AutomationDatabase } from '../db/database';
import { OrchestratorCoordinator } from './coordinator';

function createStack() {
  const db = new AutomationDatabase(':memory:');
  const coordinator = new OrchestratorCoordinator(db);
  return { db, coordinator };
}

describe('OrchestratorCoordinator', () => {
  it('grants the slot to the first claimant', () => {
    const { coordinator } = createStack();
    const now = 1_000_000;
    coordinator.upsertWorker({ workerId: 'w1', apiUrl: 'http://w1', groups: ['-1'] });
    coordinator.upsertWorker({ workerId: 'w2', apiUrl: 'http://w2', groups: ['-1'] });

    const decision = coordinator.applyClaim('-1', 'Grupo A', 'w1', now);
    expect(decision.granted).toBe(true);
  });

  it('denies a second worker while the lock is active, then allows it after expiry', () => {
    const { coordinator } = createStack();
    const now = 1_000_000;
    coordinator.upsertWorker({ workerId: 'w1', apiUrl: 'http://w1', groups: ['-1'] });
    coordinator.upsertWorker({ workerId: 'w2', apiUrl: 'http://w2', groups: ['-1'] });

    coordinator.applyClaim('-1', 'Grupo A', 'w1', now);
    const denied = coordinator.applyClaim('-1', 'Grupo A', 'w2', now + 10);
    expect(denied.granted).toBe(false);

    const afterLock = coordinator.applyClaim('-1', 'Grupo A', 'w2', now + 91);
    expect(afterLock.granted).toBe(true);
  });

  it('expires the fairness turn with the resend window', () => {
    const { coordinator } = createStack();
    const now = 1_000_000;
    coordinator.upsertWorker({ workerId: 'w1', apiUrl: 'http://w1', groups: ['-1'] });
    coordinator.upsertWorker({ workerId: 'w2', apiUrl: 'http://w2', groups: ['-1'] });

    // Only w1 ever used the group, with a non-success result so the global
    // cooldown does not interfere with the fairness checks below
    coordinator.applyClaim('-1', 'Grupo A', 'w1', now);
    coordinator.applyReport('w1', '-1', 'blocked', now + 5);

    const denied = coordinator.applyClaim('-1', 'Grupo A', 'w1', now + 100);
    expect(denied.granted).toBe(false);
    expect((denied as { reason?: string }).reason).toBe('fairness_wait');

    // The contender can take its turn at any time
    const contender = coordinator.applyClaim('-1', 'Grupo A', 'w2', now + 100);
    expect(contender.granted).toBe(true);

    // Once the window passes the group reopens to w1 even though the
    // contender never used its turn
    const reopened = coordinator.applyClaim('-1', 'Grupo A', 'w1', now + 700);
    expect(reopened.granted).toBe(true);
  });

  it('enforces the global per-group timeline after a successful report', () => {
    const { coordinator } = createStack();
    const now = 1_000_000;
    coordinator.upsertWorker({ workerId: 'w1', apiUrl: 'http://w1', groups: ['-1'] });

    coordinator.applyClaim('-1', 'Grupo A', 'w1', now);
    coordinator.applyReport('w1', '-1', 'success', now + 5);

    const tooSoon = coordinator.applyClaim('-1', 'Grupo A', 'w1', now + 100);
    expect(tooSoon.granted).toBe(false);

    const afterGap = coordinator.applyClaim('-1', 'Grupo A', 'w1', now + 1000);
    expect(afterGap.granted).toBe(true);
  });

  it('quarantines the group globally when a worker reports stars or blocked', () => {
    const { db, coordinator } = createStack();
    const now = 1_000_000;
    coordinator.upsertWorker({ workerId: 'w1', apiUrl: 'http://w1', groups: ['-1'] });

    coordinator.applyClaim('-1', 'Grupo A', 'w1', now);
    coordinator.applyReport('w1', '-1', 'stars', now + 5);

    expect(db.getGroupState('-1')?.status).toBe('STARS');
  });

  it('applies group flood cooldown to every worker', () => {
    const { coordinator } = createStack();
    const now = 1_000_000;
    coordinator.upsertWorker({ workerId: 'w1', apiUrl: 'http://w1', groups: ['-1'] });
    coordinator.upsertWorker({ workerId: 'w2', apiUrl: 'http://w2', groups: ['-1'] });

    coordinator.applyClaim('-1', 'Grupo A', 'w1', now);
    coordinator.applyReport('w1', '-1', 'flood', now + 5);

    const other = coordinator.applyClaim('-1', 'Grupo A', 'w2', now + 120);
    expect(other.granted).toBe(false);
  });

  it('rebalances meta targets over alive workers only', () => {
    const { coordinator } = createStack();
    const now = 1_000_000;
    coordinator.upsertWorker({ workerId: 'w1', apiUrl: 'http://w1', groups: [] });
    coordinator.upsertWorker({ workerId: 'w2', apiUrl: 'http://w2', groups: [] });
    // w2 stale heartbeat
    (coordinator as any).db.rawDb()
      .prepare('UPDATE orchestrator_workers SET last_heartbeat_at = ? WHERE worker_id = ?')
      .run(now - 120, 'w2');

    coordinator.rebalanceMetaTargets(40, now);
    expect(coordinator.getWorker('w1')?.metaTarget).toBe(40);
    expect(coordinator.getWorker('w2')?.metaTarget).toBeUndefined();
  });

  it('aggregates stats across alive workers', () => {
    const { coordinator } = createStack();
    const now = Math.floor(Date.now() / 1000);
    coordinator.upsertWorker({
      workerId: 'w1', apiUrl: 'http://w1', groups: ['-1'],
      statusSnapshot: { todaySent: 5 },
    });
    (coordinator as any).db.rawDb()
      .prepare('UPDATE orchestrator_workers SET last_heartbeat_at = ? WHERE worker_id = ?')
      .run(now, 'w1');

    const stats = coordinator.getAggregatedStats(now);
    expect(stats.configuredWorkers).toBe(1);
    expect(stats.aliveWorkers).toBe(1);
    expect(stats.totalTodaySent).toBe(5);
  });

  it('does not double count the master own registration in the aggregate', () => {
    // Found live on 10/10: the master self-registers as a worker, and the
    // aggregate summed its snapshot on top of the fresh own-DB count
    const { coordinator, db } = createStack();
    const now = Math.floor(Date.now() / 1000);
    coordinator.upsertWorker({
      workerId: 'account-1', apiUrl: 'http://master', groups: [],
      statusSnapshot: { todaySent: 7 },
    });
    coordinator.upsertWorker({
      workerId: 'account-2', apiUrl: 'http://worker', groups: [],
      statusSnapshot: { todaySent: 5 },
    });
    (coordinator as any).db.rawDb()
      .prepare('UPDATE orchestrator_workers SET last_heartbeat_at = ? WHERE worker_id = ?')
      .run(now, 'account-1');
    (coordinator as any).db.rawDb()
      .prepare('UPDATE orchestrator_workers SET last_heartbeat_at = ? WHERE worker_id = ?')
      .run(now, 'account-2');
    db.addLog({
      createdAt: now, chatId: 'x', chatTitle: 't', messageSnippet: 'm', linkUsed: '', status: 'SUCCESS',
    });

    const stats = coordinator.getAggregatedStats(now, 'account-1');
    // Own fresh count (1) + the other worker (5); the self snapshot (7) is
    // never added on top
    expect(stats.totalTodaySent).toBe(6);
  });
});
