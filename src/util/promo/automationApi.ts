export type AutomationStatusType =
  | 'STOPPED'
  | 'RUNNING'
  | 'PAUSED'
  | 'SLEEP_WINDOW'
  | 'CIRCUIT_BREAKER'
  | 'MICRO_PAUSE'
  | 'WAITING_NEXT_ROUND'
  | 'WAITING_COOLDOWN'
  | 'WAITING_MESSAGES';

export interface AutomationStatusResponse {
  isRunning: boolean;
  status: AutomationStatusType;
  isTelegramConnected: boolean;
  currentChatId?: string;
  currentChatTitle?: string;
  nextRunAt?: number;
  sleepUntil?: number;
  activeRound: number;
  sentInRoundCount?: number;
  waitingReason?: string;
  lastError?: string;
  stats: {
    todaySent: number;
    dailyLimit: number;
    totalGroups: number;
    readyCount: number;
    waitingSlowmodeCount: number;
    waitingMessagesCount: number;
    blockedCount: number;
    starsCount?: number;
  };
  config: {
    mode: 'manual' | 'continuous';
    minDelaySeconds: number;
    maxDelaySeconds: number;
    roundIntervalMinutes: number;
    roundTargetSends?: number;
    minOtherMessages: number;
    minResendIntervalMinutes?: number;
    sleepWindowEnabled: boolean;
    sleepWindowStart: string;
    sleepWindowEnd: string;
    dailyLimit: number;
    linkPreviewEnabled: boolean;
    microPauseEnabled?: boolean;
    microPauseEveryMin?: number;
    microPauseEveryMax?: number;
    microPauseSeconds?: number;
    extractorEnabled?: boolean;
  };
  campaign: {
    spintaxTemplate: string;
    links: string[];
    updatedAt: number;
  };
}

export interface AutomationGroupState {
  chatId: string;
  title: string;
  lastSentAt?: number;
  otherMessagesCount: number;
  slowmodeSeconds: number;
  slowmodeNextSendDate?: number;
  starsCost?: number;
  status: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' | 'STARS' | 'SENT';
  lastError?: string;
  updatedAt: number;
}

export interface AutomationLogItem {
  id?: number;
  createdAt: number;
  chatId: string;
  chatTitle: string;
  messageSnippet: string;
  linkUsed: string;
  status: 'SUCCESS' | 'FLOOD_WAIT' | 'ERROR' | 'SKIPPED';
  details?: string;
}

const TOKEN_STORAGE_KEY = 'automationApiToken';

// Reads the token once from the URL (?automationToken=...) and persists it,
// so the panel keeps working when AUTOMATION_API_TOKEN is enabled server-side.
function getApiToken(): string | undefined {
  const hashQuery = window.location.hash.includes('?')
    ? window.location.hash.slice(window.location.hash.indexOf('?'))
    : '';
  const fromUrl = new URLSearchParams(window.location.search).get('automationToken')
    || (hashQuery ? new URLSearchParams(hashQuery).get('automationToken') : undefined);
  if (fromUrl) {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, fromUrl);
    } catch { /* storage unavailable */ }
    return fromUrl;
  }

  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getApiToken();
  const res = await fetch(`/api/v1/automation/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    let msg = `HTTP error ${res.status}`;
    try {
      const errJson = await res.json();
      if (errJson.error) msg = errJson.error;
    } catch {
      // ignore
    }
    throw new Error(msg);
  }

  return res.json();
}

export function fetchAutomationStatus(): Promise<AutomationStatusResponse> {
  return request<AutomationStatusResponse>('status');
}

export interface ExtractedLinkItem {
  kind: string;
  value: string;
  domain?: string;
  preview?: string;
  sourceChatId: string;
  sourceChatTitle: string;
  firstSeenAt: number;
  lastSeenAt: number;
  timesSeen: number;
}

export interface ExtractStatsResponse {
  enabled: boolean;
  byKind: { kind: string; total: number; last24h: number; sourceChats: number }[];
}

export function fetchExtractedLinks(options: {
  kind?: string;
  q?: string;
  limit?: number;
  sort?: 'recent' | 'seen';
} = {}): Promise<ExtractedLinkItem[]> {
  const params = new URLSearchParams();
  if (options.kind) params.set('kind', options.kind);
  if (options.q) params.set('q', options.q);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.sort) params.set('sort', options.sort);
  const qs = params.toString();
  return request<ExtractedLinkItem[]>(`extract/links${qs ? `?${qs}` : ''}`);
}

export function fetchExtractStats(): Promise<ExtractStatsResponse> {
  return request<ExtractStatsResponse>('extract/stats');
}

export function clearExtractedLinks(kind?: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('extract/clear', {
    method: 'POST',
    body: JSON.stringify(kind ? { kind } : {}),
  });
}

export async function downloadExtractedLinks(kind?: string): Promise<void> {
  const token = getApiToken();
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  const res = await fetch(`/api/v1/automation/extract/export${qs}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `extracted-${kind || 'all'}.txt`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function startAutomationTakeover(payload: {
  sessionData: any;
  targetChats: {
    id: string;
    title: string;
    accessHash?: string;
    slowmodeSeconds?: number;
    slowmodeNextSendDate?: number;
    lastSentAt?: number;
    starsCost?: number;
    status?: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' | 'STARS' | 'SENT';
  }[];
}): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('takeover', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function stopAutomationRelease(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('release', {
    method: 'POST',
  });
}

export function saveAutomationConfig(patch: Partial<AutomationStatusResponse['config']>): Promise<any> {
  return request('config', {
    method: 'POST',
    body: JSON.stringify(patch),
  });
}

export function saveAutomationCampaign(spintaxTemplate: string, links: string[]): Promise<any> {
  return request('campaign', {
    method: 'POST',
    body: JSON.stringify({ spintaxTemplate, links }),
  });
}

export function fetchAutomationGroups(): Promise<AutomationGroupState[]> {
  return request<AutomationGroupState[]>('groups');
}

export function fetchAutomationLogs(limit = 50): Promise<AutomationLogItem[]> {
  return request<AutomationLogItem[]>(`logs?limit=${limit}`);
}

export function testSpintaxPreviews(
  template: string,
  links: string[],
): Promise<{ previews: { messageText: string; linkUsed: string }[] }> {
  return request<{ previews: { messageText: string; linkUsed: string }[] }>('test-spintax', {
    method: 'POST',
    body: JSON.stringify({ template, links }),
  });
}

export function skipAutomationPause(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('skip-pause', {
    method: 'POST',
  });
}

export function fetchAutomationDebug(): Promise<any> {
  return request<any>('debug');
}

export function forceNewAutomationRound(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('force-new-round', {
    method: 'POST',
  });
}

export function reconnectAutomationTelegram(): Promise<{ success: boolean; message: string }> {
  return request<{ success: boolean; message: string }>('reconnect', {
    method: 'POST',
  });
}

// ---- Orchestration (master-only endpoints; 404/missing on workers) ----

export interface OrchestratorInfo {
  isMaster: boolean;
  workerId: string;
  configuredWorkers: number;
  aliveWorkers: number;
  degradedWorkers: number;
  totalTodaySent: number;
  aliveWorkerIds: string[];
}

export interface OrchestratorWorker {
  workerId: string;
  apiUrl: string;
  groups: string[];
  version?: string;
  statusSnapshot?: {
    scheduler?: { status?: string; activeRound?: number; sentInRoundCount?: number };
    todaySent?: number;
    isDegraded?: boolean;
  };
  metaTarget?: number;
  lastHeartbeatAt: number;
  isAlive?: boolean;
}

export interface OrchestratorGrant {
  id: number;
  chatId: string;
  chatTitle: string;
  workerId: string;
  grantedAt: number;
  lockUntil: number;
  result?: string;
}

async function requestOrchestrator<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getApiToken();
  const res = await fetch(`/api/v1/orchestrator/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);
  return res.json();
}

export async function fetchOrchestratorInfo(): Promise<OrchestratorInfo | undefined> {
  try {
    return await requestOrchestrator<OrchestratorInfo>('info');
  } catch {
    return undefined;
  }
}

export function fetchOrchestratorWorkers(): Promise<OrchestratorWorker[]> {
  return requestOrchestrator<OrchestratorWorker[]>('workers');
}

export function fetchOrchestratorGrants(limit = 100): Promise<OrchestratorGrant[]> {
  return requestOrchestrator<OrchestratorGrant[]>(`grants?limit=${limit}`);
}
