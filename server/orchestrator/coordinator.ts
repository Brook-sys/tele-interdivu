// node:sqlite requires literal null to bind SQL NULL values
/* eslint-disable no-null/no-null */

import type { AutomationDatabase, GroupStateRecord } from '../db/database';

export interface OrchestratorWorkerRecord {
  workerId: string;
  apiUrl: string;
  groups: string[];
  version?: string;
  statusSnapshot?: Record<string, unknown>;
  metaTarget?: number;
  lastHeartbeatAt: number;
  registeredAt: number;
  pendingCommand?: OrchestratorCommand;
  lastCommandAck?: OrchestratorCommandAck;
}

// Command issued from the orchestration panel, delivered through the
// heartbeat response and acknowledged on the next worker heartbeat
export interface OrchestratorCommand {
  id: string;
  type: 'start' | 'stop' | 'campaign-copy';
  payload?: unknown;
  issuedAt: number;
}

export interface OrchestratorCommandAck {
  id: string;
  ok: boolean;
  message?: string;
  error?: string;
  at: number;
}

export type OrchestratorCommandResult = Pick<OrchestratorCommandAck, 'ok' | 'message' | 'error'>;

export interface GrantRecord {
  id?: number;
  chatId: string;
  chatTitle: string;
  workerId: string;
  grantedAt: number;
  lockUntil: number;
  result?: 'success' | 'slowmode' | 'flood' | 'stars' | 'blocked' | 'error';
}

export type ClaimResponse =
  | { granted: true; lockUntil: number }
  | { granted: false; retryAfterMs: number; reason?: string };

const HEARTBEAT_TTL_SECONDS = 45;
const LOCK_TTL_SECONDS = 90;
const DEFAULT_RESEND_GAP_SECONDS = 600; // global floor between sends to the same group
const GROUP_FLOOD_COOLDOWN_SECONDS = 3600;
const COMMAND_TTL_SECONDS = 120;

// Allocates send slots globally: per-group timeline so two accounts never send
// to the same group too close together, plus round-robin across workers so
// sends interleave between accounts naturally.
export class OrchestratorCoordinator {
  constructor(private readonly db: AutomationDatabase) {}

  upsertWorker(worker: Omit<OrchestratorWorkerRecord, 'registeredAt' | 'lastHeartbeatAt'>) {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.getWorker(worker.workerId);
    this.dbRaw().prepare(`
      INSERT INTO orchestrator_workers (
        worker_id, api_url, groups_json, version, status_snapshot_json,
        meta_target, last_heartbeat_at, registered_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(worker_id) DO UPDATE SET
        api_url = excluded.api_url,
        groups_json = excluded.groups_json,
        version = excluded.version,
        status_snapshot_json = excluded.status_snapshot_json,
        meta_target = excluded.meta_target,
        last_heartbeat_at = excluded.last_heartbeat_at
    `).run(
      worker.workerId,
      worker.apiUrl,
      JSON.stringify(worker.groups),
      worker.version ?? null,
      worker.statusSnapshot ? JSON.stringify(worker.statusSnapshot) : null,
      worker.metaTarget ?? null,
      now,
      existing?.registeredAt ?? now,
    );
  }

  getWorker(workerId: string): OrchestratorWorkerRecord | undefined {
    const row = this.dbRaw().prepare(
      'SELECT * FROM orchestrator_workers WHERE worker_id = ?',
    ).get(workerId) as any;
    return row ? this.mapWorker(row) : undefined;
  }

  listWorkers(): OrchestratorWorkerRecord[] {
    const rows = this.dbRaw().prepare(
      'SELECT * FROM orchestrator_workers ORDER BY worker_id',
    ).all() as any[];
    return rows.map((row) => this.mapWorker(row));
  }

  getAliveWorkers(serverNow: number): OrchestratorWorkerRecord[] {
    return this.listWorkers().filter(
      (worker) => serverNow - worker.lastHeartbeatAt <= HEARTBEAT_TTL_SECONDS,
    );
  }

  deleteWorker(workerId: string) {
    this.dbRaw().prepare('DELETE FROM orchestrator_workers WHERE worker_id = ?').run(workerId);
  }

  setWorkerMetaTarget(workerId: string, metaTarget: number) {
    this.dbRaw().prepare(
      'UPDATE orchestrator_workers SET meta_target = ? WHERE worker_id = ?',
    ).run(metaTarget, workerId);
  }

  // A global round target only exists while the master defines one; without
  // it every account falls back to its own local target
  clearMetaTargets() {
    this.dbRaw().prepare(
      'UPDATE orchestrator_workers SET meta_target = NULL WHERE meta_target IS NOT NULL',
    ).run();
  }

  // ---- Pending command channel ----

  setPendingCommand(workerId: string, command: OrchestratorCommand): boolean {
    if (!this.getWorker(workerId)) return false;
    this.dbRaw().prepare(
      'UPDATE orchestrator_workers SET pending_command_json = ? WHERE worker_id = ?',
    ).run(JSON.stringify(command), workerId);
    return true;
  }

  // Returns the pending command for a worker, expiring stale ones so a
  // long-dead command never fires when the account comes back online
  takePendingCommand(workerId: string, serverNow: number): OrchestratorCommand | undefined {
    const worker = this.getWorker(workerId);
    if (!worker?.pendingCommand) return undefined;
    if (serverNow - worker.pendingCommand.issuedAt > COMMAND_TTL_SECONDS) {
      this.dbRaw().prepare(
        'UPDATE orchestrator_workers SET pending_command_json = ?, last_command_ack_json = ? WHERE worker_id = ?',
      ).run(
        null,
        JSON.stringify({
          id: worker.pendingCommand.id,
          ok: false,
          error: 'Command expired before execution',
          at: serverNow,
        }),
        workerId,
      );
      return undefined;
    }
    return worker.pendingCommand;
  }

  ackCommand(workerId: string, ack: OrchestratorCommandAck) {
    const worker = this.getWorker(workerId);
    if (!worker) return;
    const acked = { ...ack, at: ack.at || Math.floor(Date.now() / 1000) };
    // The pending command is cleared when the ack matches; an ack for an
    // unknown id leaves any newer command untouched
    const remainingPending = worker.pendingCommand?.id === ack.id
      ? undefined
      : worker.pendingCommand;
    this.dbRaw().prepare(
      'UPDATE orchestrator_workers SET last_command_ack_json = ?, pending_command_json = ? WHERE worker_id = ?',
    ).run(
      JSON.stringify(acked),
      remainingPending ? JSON.stringify(remainingPending) : null,
      workerId,
    );
  }

  // Pure scheduling decision, exposed for testing
  decideClaim(
    chatId: string,
    workerId: string,
    serverNow: number,
    grants: GrantRecord[],
    aliveWorkerIds: string[],
    workerGroups: Record<string, string[]>,
    resendGapSeconds = DEFAULT_RESEND_GAP_SECONDS,
  ): ClaimResponse {
    if (!workerGroups[workerId]?.includes(chatId)) {
      return { granted: false, retryAfterMs: 30_000, reason: 'group_not_owned' };
    }

    const chatGrants = grants.filter((grant) => grant.chatId === chatId);

    // Active lock held by another worker
    const activeLock = chatGrants.find(
      (grant) => !grant.result && grant.lockUntil > serverNow && grant.workerId !== workerId,
    );
    if (activeLock) {
      return { granted: false, retryAfterMs: (activeLock.lockUntil - serverNow) * 1000, reason: 'locked' };
    }

    // Global per-group timeline: last reported success + gap
    const lastSuccess = chatGrants.find((grant) => grant.result === 'success');
    if (lastSuccess && lastSuccess.grantedAt + resendGapSeconds > serverNow) {
      return {
        granted: false,
        retryAfterMs: (lastSuccess.grantedAt + resendGapSeconds - serverNow) * 1000,
        reason: 'group_cooldown',
      };
    }

    // Group-level circuit state: any reported flood/stars/blocked blocks the group
    const blocking = chatGrants.find((grant) => (
      grant.result === 'flood' && grant.grantedAt + GROUP_FLOOD_COOLDOWN_SECONDS > serverNow
    ));
    if (blocking) {
      return {
        granted: false,
        retryAfterMs: (blocking.grantedAt + GROUP_FLOOD_COOLDOWN_SECONDS - serverNow) * 1000,
        reason: 'group_flood_cooldown',
      };
    }

    // Round-robin between accounts: the claimant wins only if no other
    // alive worker (that owns this group) has an older last grant on it
    const contenders = aliveWorkerIds.filter((id) => id !== workerId && workerGroups[id]?.includes(chatId));
    for (const otherId of contenders) {
      const otherLastGrant = grants
        .filter((grant) => grant.workerId === otherId && grant.chatId === chatId)
        .map((grant) => grant.grantedAt)
        .sort((a, b) => b - a)[0] ?? 0;
      const myLastGrant = grants
        .filter((grant) => grant.workerId === workerId && grant.chatId === chatId)
        .map((grant) => grant.grantedAt)
        .sort((a, b) => b - a)[0] ?? 0;

      if (otherLastGrant < myLastGrant) {
        return { granted: false, retryAfterMs: 15_000, reason: 'fairness_wait' };
      }
    }

    return { granted: true, lockUntil: serverNow + LOCK_TTL_SECONDS };
  }

  applyClaim(chatId: string, chatTitle: string, workerId: string, serverNow: number) {
    const config = this.db.getConfig();
    const aliveWorkers = this.getAliveWorkers(serverNow);
    const decision = this.decideClaim(
      chatId,
      workerId,
      serverNow,
      this.listGrants(),
      aliveWorkers.map((worker) => worker.workerId),
      Object.fromEntries(aliveWorkers.map((worker) => [worker.workerId, worker.groups])),
      Math.max(60, (config.minResendIntervalMinutes || 10) * 60),
    );
    if (!decision.granted) return decision;

    this.dbRaw().prepare(`
      INSERT INTO orchestrator_grants (chat_id, chat_title, worker_id, granted_at, lock_until, result)
      VALUES (?, ?, ?, ?, ?, NULL)
    `).run(chatId, chatTitle, workerId, serverNow, decision.lockUntil);

    return decision;
  }

  applyReport(workerId: string, chatId: string, result: GrantRecord['result'], serverNow: number) {
    const open = this.dbRaw().prepare(`
      SELECT id FROM orchestrator_grants
      WHERE worker_id = ? AND chat_id = ? AND result IS NULL
      ORDER BY id DESC LIMIT 1
    `).get(workerId, chatId) as any;
    if (!open) return false;

    this.dbRaw().prepare(
      'UPDATE orchestrator_grants SET result = ? WHERE id = ?',
    ).run(result ?? 'error', open.id);

    // Global quarantine propagation: stars/blocked apply to every worker
    if (result === 'stars' || result === 'blocked') {
      const titleRow = this.dbRaw().prepare(
        'SELECT chat_title FROM orchestrator_grants WHERE chat_id = ? ORDER BY id DESC LIMIT 1',
      ).get(chatId) as any;
      this.db.upsertGroupState({
        chatId,
        title: titleRow?.chat_title || chatId,
        otherMessagesCount: 0,
        slowmodeSeconds: 0,
        starsCost: 0,
        status: result === 'stars' ? 'STARS' : 'BLOCKED',
        lastError: `Quarentena global via orquestrador (${result})`,
      });
      void serverNow;
    }
    return true;
  }

  listGrants(limit = 100): GrantRecord[] {
    const rows = this.dbRaw().prepare(`
      SELECT * FROM orchestrator_grants ORDER BY id DESC LIMIT ?
    `).all(Math.min(500, Math.max(1, limit))) as any[];
    return rows.map((row) => ({
      id: Number(row.id),
      chatId: String(row.chat_id),
      chatTitle: String(row.chat_title),
      workerId: String(row.worker_id),
      grantedAt: Number(row.granted_at),
      lockUntil: Number(row.lock_until),
      result: row.result ?? undefined,
    }));
  }

  getAggregatedStats(serverNow: number) {
    const workers = this.listWorkers();
    const alive = workers.filter((worker) => serverNow - worker.lastHeartbeatAt <= HEARTBEAT_TTL_SECONDS);

    let totalToday = this.db.getTodaySentCount(serverNow);
    for (const worker of alive) {
      const snapshot = worker.statusSnapshot as { todaySent?: number } | undefined;
      totalToday += snapshot?.todaySent ?? 0;
    }

    return {
      configuredWorkers: workers.length,
      aliveWorkers: alive.length,
      degradedWorkers: alive.filter((worker) => {
        const snapshot = worker.statusSnapshot as { isDegraded?: boolean } | undefined;
        return Boolean(snapshot?.isDegraded);
      }).length,
      totalTodaySent: totalToday,
      aliveWorkerIds: alive.map((worker) => worker.workerId),
    };
  }

  rebalanceMetaTargets(globalTarget: number, serverNow: number) {
    const alive = this.getAliveWorkers(serverNow);
    if (!alive.length) return;

    const perWorker = Math.max(1, Math.floor(globalTarget / alive.length));
    const remainder = globalTarget % alive.length;
    alive.forEach((worker, index) => {
      this.setWorkerMetaTarget(worker.workerId, perWorker + (index < remainder ? 1 : 0));
    });
  }

  private mapWorker(row: any): OrchestratorWorkerRecord {
    let pendingCommand: OrchestratorCommand | undefined;
    try {
      pendingCommand = row.pending_command_json ? JSON.parse(row.pending_command_json) : undefined;
    } catch {
      pendingCommand = undefined;
    }
    let lastCommandAck: OrchestratorCommandAck | undefined;
    try {
      lastCommandAck = row.last_command_ack_json ? JSON.parse(row.last_command_ack_json) : undefined;
    } catch {
      lastCommandAck = undefined;
    }
    return {
      workerId: String(row.worker_id),
      apiUrl: String(row.api_url),
      groups: JSON.parse(row.groups_json || '[]'),
      version: row.version ? String(row.version) : undefined,
      statusSnapshot: row.status_snapshot_json ? JSON.parse(row.status_snapshot_json) : undefined,
      metaTarget: row.meta_target !== null && row.meta_target !== undefined ? Number(row.meta_target) : undefined,
      lastHeartbeatAt: Number(row.last_heartbeat_at ?? 0),
      registeredAt: Number(row.registered_at),
      pendingCommand,
      lastCommandAck,
    };
  }

  private dbRaw() {
    return this.db.rawDb();
  }
}

export type { GroupStateRecord };
