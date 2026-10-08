import type { AutomationDatabase, AutomationDbConfig } from '../db/database';
import type {
  OrchestratorCommand,
  OrchestratorCommandAck,
  OrchestratorCommandResult,
} from './coordinator';

export type OrchestratorSendResult = 'success' | 'slowmode' | 'flood' | 'stars' | 'blocked' | 'error';

interface ClaimDecision {
  granted: boolean;
  lockUntil?: number;
  retryAfterMs?: number;
  reason?: string;
}

interface HeartbeatResponse {
  serverNow: number;
  // Global overrides currently defined on the master: presence of the key
  // (even as `{}`) refreshes the local cache; absence keeps the last one so
  // mixed-image deploys never wipe state
  overrides?: Partial<AutomationDbConfig>;
  roundTargetShare?: number;
  command?: OrchestratorCommand;
}

export type OrchestratorCommandHandler = (
  command: OrchestratorCommand,
) => Promise<OrchestratorCommandResult>;

const REQUEST_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15_000;

// Worker-side orchestrator client. Each account keeps its own local config
// and campaign; the master only pushes sparse global overrides (cached here,
// never written over local values) and per-account commands. When the master
// is unreachable the client marks itself degraded and the scheduler falls
// back to fully local behavior, keeping the last cached overrides.
export class OrchestratorWorkerClient {
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  private isDegraded = false;

  private hasLoggedDegraded = false;

  private hasLoggedRegistered = false;

  private pendingAcks: OrchestratorCommandAck[] = [];

  constructor(
    private readonly db: AutomationDatabase,
    private readonly masterUrl: string,
    private readonly workerId: string,
    private readonly workerApiUrl: string,
    private readonly token?: string,
    private readonly handleCommand?: OrchestratorCommandHandler,
    private readonly heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  ) {}

  static fromEnv(
    db: AutomationDatabase,
    handleCommand?: OrchestratorCommandHandler,
  ): OrchestratorWorkerClient | undefined {
    const masterUrl = process.env.MASTER_URL;
    if (!masterUrl) return undefined;

    const workerId = process.env.WORKER_ID || process.env.HOSTNAME || `worker-${Date.now()}`;
    const workerApiUrl = process.env.WORKER_API_URL;
    if (!workerApiUrl) {
      // eslint-disable-next-line no-console
      console.warn('[Orchestrator] MASTER_URL is set but WORKER_API_URL is missing — skipping registration');
      return undefined;
    }

    return new OrchestratorWorkerClient(
      db,
      masterUrl.replace(/\/+$/, ''),
      workerId,
      workerApiUrl.replace(/\/+$/, ''),
      process.env.ORCHESTRATOR_TOKEN || process.env.AUTOMATION_API_TOKEN,
      handleCommand,
    );
  }

  // A master with no MASTER_URL of its own registers its own account as a
  // worker through its local daemon API, so its sends are coordinated under
  // the same global rules and it appears in the orchestration panel
  static createSelf(
    db: AutomationDatabase,
    daemonUrl: string,
    workerId: string,
    workerApiUrl: string,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    handleCommand?: OrchestratorCommandHandler,
  ): OrchestratorWorkerClient {
    return new OrchestratorWorkerClient(
      db,
      daemonUrl.replace(/\/+$/, ''),
      workerId,
      (workerApiUrl || daemonUrl).replace(/\/+$/, ''),
      process.env.ORCHESTRATOR_TOKEN || process.env.AUTOMATION_API_TOKEN,
      handleCommand,
      heartbeatIntervalMs,
    );
  }

  getWorkerId() {
    return this.workerId;
  }

  getIsDegraded() {
    return this.isDegraded;
  }

  // Logs only state transitions so a down master does not spam the log every
  // heartbeat tick, while still surfacing the failure reason for debugging
  private markHealthy() {
    if (this.isDegraded) {
      this.hasLoggedDegraded = false;
      // eslint-disable-next-line no-console
      console.log(`[Interdivu Orchestrator] Link with the master restored ('${this.workerId}' is healthy)`);
    }
    this.isDegraded = false;
  }

  private markDegraded(reason: string) {
    if (!this.hasLoggedDegraded) {
      this.hasLoggedDegraded = true;
      // eslint-disable-next-line no-console
      console.warn(`[Interdivu Orchestrator] ${reason} — running degraded (local-only) and retrying`);
    }
    this.isDegraded = true;
  }

  // Global overrides land in the dedicated cache table; the local config
  // table is never touched, so removing an override restores local behavior
  private applyGlobalState(response: HeartbeatResponse) {
    if (!Object.prototype.hasOwnProperty.call(response, 'overrides')) return;
    this.db.saveOrchestratorCache({
      overrides: response.overrides || {},
      roundTargetShare: response.roundTargetShare,
    });
  }

  // Commands are idempotent on the executor (start when running is a no-op,
  // stop when stopped is a no-op, campaign copy replaces content), so a lost
  // ack followed by re-delivery is harmless
  private async executeCommand(command: OrchestratorCommand): Promise<OrchestratorCommandAck> {
    const at = Math.floor(Date.now() / 1000);
    if (!this.handleCommand) {
      return { id: command.id, ok: false, error: 'No command handler configured', at };
    }
    let ack: OrchestratorCommandAck;
    try {
      const result = await this.handleCommand(command);
      ack = { id: command.id, ...result, at };
    } catch (err: any) {
      ack = { id: command.id, ok: false, error: err?.message || String(err), at };
    }
    // eslint-disable-next-line no-console
    console.log(
      `[Interdivu Orchestrator] Command '${command.type}' ${ack.ok ? 'executed' : `failed: ${ack.error}`}`,
    );
    return ack;
  }

  startHeartbeatLoop(getStatus: () => Record<string, unknown>) {
    if (this.heartbeatTimer) return;

    const tick = async () => {
      const groups = this.db.getAllGroupStates().map((group) => group.chatId);
      try {
        const response = await this.post('heartbeat', {
          workerId: this.workerId,
          apiUrl: this.workerApiUrl,
          groups,
          status: getStatus(),
          commandAcks: this.pendingAcks,
        }) as HeartbeatResponse;

        this.markHealthy();
        this.applyGlobalState(response);
        // The master consumes acks while building this response, so whatever
        // is still listed as pending here was issued after our request
        this.pendingAcks = [];
        if (response.command) {
          const ack = await this.executeCommand(response.command);
          this.pendingAcks.push(ack);
          // Fast feedback: push the ack right away so the panel does not
          // wait for the next heartbeat; the heartbeat drain above remains
          // as backup when this post is lost
          void this.post('command-ack', { workerId: this.workerId, ack }).catch(() => {});
        }
      } catch (err: any) {
        this.markDegraded(`heartbeat failed: ${err?.message || err}`);
      }
    };

    // Register immediately, then heartbeat on a fixed cadence
    const groups = this.db.getAllGroupStates().map((group) => group.chatId);
    this.post('register', { workerId: this.workerId, apiUrl: this.workerApiUrl, groups })
      .then(() => {
        this.markHealthy();
        if (!this.hasLoggedRegistered) {
          this.hasLoggedRegistered = true;
          // eslint-disable-next-line no-console
          console.log(`[Interdivu Orchestrator] Registered as '${this.workerId}' with the master`);
        }
      })
      .catch((err: any) => this.markDegraded(`register failed: ${err?.message || err}`))
      .finally(() => {
        this.heartbeatTimer = setInterval(() => void tick(), this.heartbeatIntervalMs);
        (this.heartbeatTimer as { unref?: () => void }).unref?.();
      });
  }

  stopHeartbeatLoop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  // Returns the master decision, or undefined when degraded (caller then
  // falls back to local-only behavior).
  async claimSendSlot(chatId: string, chatTitle: string): Promise<ClaimDecision | undefined> {
    try {
      const decision = await this.post('claim', { workerId: this.workerId, chatId, chatTitle }) as ClaimDecision;
      this.markHealthy();
      return decision;
    } catch (err: any) {
      this.markDegraded(`claim failed: ${err?.message || err}`);
      return undefined;
    }
  }

  async reportSendResult(chatId: string, result: OrchestratorSendResult) {
    try {
      await this.post('report', { workerId: this.workerId, chatId, result });
    } catch (err: any) {
      this.markDegraded(`report failed: ${err?.message || err}`);
    }
  }

  private async post(path: string, body: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${this.masterUrl}/api/v1/orchestrator/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new Error(`Orchestrator HTTP ${res.status}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }
}
