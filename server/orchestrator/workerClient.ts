import type { AutomationDatabase, AutomationDbConfig } from '../db/database';

export type OrchestratorSendResult = 'success' | 'slowmode' | 'flood' | 'stars' | 'blocked' | 'error';

interface ClaimDecision {
  granted: boolean;
  lockUntil?: number;
  retryAfterMs?: number;
  reason?: string;
}

interface HeartbeatResponse {
  serverNow: number;
  desiredConfig?: Partial<AutomationDbConfig>;
  desiredCampaign?: {
    spintaxTemplate?: string;
    links?: string[];
    templates?: { title: string; content: string; weight: number; isEnabled: boolean }[];
    allLinks?: { url: string; isEnabled: boolean; destinationIndex?: number }[];
    destinations?: { name: string; weight: number; isEnabled: boolean }[];
  };
}

const REQUEST_TIMEOUT_MS = 5000;
const HEARTBEAT_INTERVAL_MS = 15_000;

// Worker-side orchestrator client. When the master is unreachable the client
// marks itself degraded and the scheduler falls back to fully local behavior
// (the standalone system that already works today).
export class OrchestratorWorkerClient {
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  private isDegraded = false;

  constructor(
    private readonly db: AutomationDatabase,
    private readonly masterUrl: string,
    private readonly workerId: string,
    private readonly workerApiUrl: string,
    private readonly token?: string,
  ) {}

  static fromEnv(db: AutomationDatabase): OrchestratorWorkerClient | undefined {
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
    );
  }

  getWorkerId() {
    return this.workerId;
  }

  getIsDegraded() {
    return this.isDegraded;
  }

  // Content-only projections so heartbeat syncs don't rewrite rows that
  // did not actually change (rewrite would churn local template ids)
  private projectTemplates(templates: { title: string; content: string; weight: number; isEnabled: boolean }[]) {
    return templates
      .map((t) => `${t.title}\u0000${t.content}\u0000${t.weight}\u0000${t.isEnabled}`)
      .join('\u0001');
  }

  private projectLinks(links: { url: string; isEnabled: boolean; destinationIndex?: number }[]) {
    return links
      .map((l) => `${l.url}\u0000${l.isEnabled}\u0000${l.destinationIndex ?? ''}`)
      .join('\u0001');
  }

  private projectDestinations(destinations: { name: string; weight: number; isEnabled: boolean }[]) {
    return destinations
      .map((d) => `${d.name}\u0000${d.weight}\u0000${d.isEnabled}`)
      .join('\u0001');
  }

  private applyDesiredCampaign(desired: NonNullable<HeartbeatResponse['desiredCampaign']>) {
    const current = this.db.getCampaign();

    if (desired.templates?.length) {
      const desiredLinks = desired.allLinks?.length
        ? desired.allLinks
        // Legacy payload: a plain url list means enabled links
        : (desired.links || []).map((url) => ({ url, isEnabled: true }));

      if (desired.destinations !== undefined) {
        // New format: destinations included — full content replace, with
        // links referencing destinations by index (local ids differ from the master's)
        const destinationIndexById = new Map(
          current.destinations.map((destination, index) => [destination.id, index]),
        );
        const currentLinks = current.allLinks.map((link) => ({
          url: link.url,
          isEnabled: link.isEnabled,
          destinationIndex: link.destinationId !== undefined
            ? destinationIndexById.get(link.destinationId) : undefined,
        }));

        const isChanged = this.projectTemplates(current.templates) !== this.projectTemplates(desired.templates)
          || this.projectLinks(currentLinks) !== this.projectLinks(desiredLinks)
          || this.projectDestinations(current.destinations) !== this.projectDestinations(desired.destinations);
        if (isChanged) {
          this.db.replaceCampaignContent(
            current.id, desired.templates, desiredLinks, desired.destinations,
          );
        }
        return;
      }

      // Legacy multi-template payload from an older master image — local
      // destinations are preserved, links come back unassigned
      const isChanged = this.projectTemplates(current.templates) !== this.projectTemplates(desired.templates)
        || this.projectLinks(current.allLinks) !== this.projectLinks(desiredLinks);
      if (isChanged) {
        this.db.replaceCampaignContent(current.id, desired.templates, desiredLinks);
      }
      return;
    }

    // Legacy single-template payload from an older master image
    if (desired.spintaxTemplate) {
      const desiredLinks = (desired.links || []).map((url) => ({ url, isEnabled: true }));
      const isChanged = current.spintaxTemplate !== desired.spintaxTemplate
        || this.projectLinks(current.allLinks) !== this.projectLinks(desiredLinks);
      if (isChanged) {
        this.db.saveCampaign(desired.spintaxTemplate, desired.links || []);
      }
    }
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
        }) as HeartbeatResponse;

        this.isDegraded = false;
        if (response.desiredConfig) {
          this.db.updateConfig(response.desiredConfig);
        }
        if (response.desiredCampaign) {
          this.applyDesiredCampaign(response.desiredCampaign);
        }
      } catch {
        // Degraded: keep working locally, keep retrying on the next ticks
        this.isDegraded = true;
      }
    };

    // Register immediately, then heartbeat on a fixed cadence
    const groups = this.db.getAllGroupStates().map((group) => group.chatId);
    this.post('register', { workerId: this.workerId, apiUrl: this.workerApiUrl, groups })
      .then(() => { this.isDegraded = false; })
      .catch(() => { this.isDegraded = true; })
      .finally(() => {
        this.heartbeatTimer = setInterval(() => void tick(), HEARTBEAT_INTERVAL_MS);
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
      this.isDegraded = false;
      return decision;
    } catch {
      this.isDegraded = true;
      return undefined;
    }
  }

  async reportSendResult(chatId: string, result: OrchestratorSendResult) {
    try {
      await this.post('report', { workerId: this.workerId, chatId, result });
    } catch {
      this.isDegraded = true;
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
