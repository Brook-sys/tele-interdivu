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
});
