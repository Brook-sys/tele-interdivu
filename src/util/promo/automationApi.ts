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
  // Remaining seconds before the session key is safe to use again after an
  // abrupt daemon end; 0 means "safe to connect now"
  sessionSafetyWaitSeconds?: number;
  // The daemon is waiting for this account's tab to hand the session over so
  // a remote start can proceed — the tab yields its client when it sees this
  browserPendingStart?: boolean;
  currentChatId?: string;
  currentChatTitle?: string;
  nextRunAt?: number;
  sleepUntil?: number;
  // Total end of the current long wait (inclui o tempo restante de fato,
  // mesmo com o fatiamento interno em blocos); na janela de sono, é o fim dela
  waitTotalUntil?: number;
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
    templateRotationEnabled?: boolean;
    memberTrackingEnabled?: boolean;
    memberTrackingIntervalHours?: number;
  };
  // Fields currently defined globally by the orchestration master; local edits
  // to those fields have no effect until the override is removed
  configOverriddenFields?: string[];
  campaign: AutomationCampaign;
}

export interface AutomationCampaignTemplate {
  id: number;
  title: string;
  content: string;
  weight: number;
  isEnabled: boolean;
  position: number;
  updatedAt: number;
}

export interface AutomationCampaignLink {
  id: number;
  url: string;
  isEnabled: boolean;
  position: number;
  updatedAt: number;
  destinationId?: number;
}

export interface CampaignDestination {
  id: number;
  name: string;
  weight: number;
  isEnabled: boolean;
  position: number;
  updatedAt: number;
}

export interface AutomationCampaign {
  id: number;
  name: string;
  spintaxTemplate: string;
  templates: AutomationCampaignTemplate[];
  destinations: CampaignDestination[];
  links: string[];
  allLinks: AutomationCampaignLink[];
  updatedAt: number;
}

export interface AutomationGroupState {
  chatId: string;
  title: string;
  lastSentAt?: number;
  otherMessagesCount: number;
  slowmodeSeconds: number;
  slowmodeNextSendDate?: number;
  starsCost?: number;
  status: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_RESEND' | 'WAITING_MESSAGES' | 'BLOCKED' | 'STARS' | 'SENT';
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
  resolvedTitle?: string;
  resolvedMembers?: number;
  resolvedType?: string;
  resolvedPhotoB64?: string;
  resolvedAbout?: string;
  resolvedAt?: number;
  resolvedFailed?: boolean;
}

export interface ResolveInviteResult {
  title: string;
  members?: number;
  chatType: string;
  about?: string;
  photoB64?: string;
}

export function resolveExtractedLink(
  kind: string,
  value: string,
): Promise<{ success: boolean; resolved: ResolveInviteResult }> {
  return request('extract/resolve', {
    method: 'POST',
    body: JSON.stringify({ kind, value }),
  });
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

export async function downloadExtractedLinks(kind?: string, format: 'txt' | 'csv' = 'txt'): Promise<void> {
  const token = getApiToken();
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (format === 'csv') params.set('format', 'csv');
  const qs = params.toString();
  const res = await fetch(`/api/v1/automation/extract/export${qs ? `?${qs}` : ''}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  if (!res.ok) throw new Error(`HTTP error ${res.status}`);

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `extracted-${kind || 'all'}.${format}`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function startAutomationTakeover(payload: {
  sessionData: any;
  // Optional when reconnecting: daemon reuses the saved rotation
  targetChats?: {
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

export function fetchAutomationCampaign(): Promise<AutomationCampaign> {
  return request<AutomationCampaign>('campaign');
}

export function saveCampaignTemplate(template: {
  id?: number;
  title?: string;
  content: string;
  weight?: number;
  isEnabled?: boolean;
}): Promise<AutomationCampaignTemplate> {
  return request<AutomationCampaignTemplate>('campaign/templates', {
    method: 'POST',
    body: JSON.stringify(template),
  });
}

export function deleteCampaignTemplate(id: number): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`campaign/templates/${id}`, {
    method: 'DELETE',
  });
}

export function saveCampaignLink(
  link: { id?: number; url: string; isEnabled?: boolean; destinationId?: number },
): Promise<AutomationCampaignLink> {
  return request<AutomationCampaignLink>('campaign/links', {
    method: 'POST',
    body: JSON.stringify(link),
  });
}

export function deleteCampaignLink(id: number): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`campaign/links/${id}`, {
    method: 'DELETE',
  });
}

export function saveCampaignDestination(destination: {
  id?: number;
  name: string;
  weight?: number;
  isEnabled?: boolean;
}): Promise<CampaignDestination> {
  return request<CampaignDestination>('campaign/destinations', {
    method: 'POST',
    body: JSON.stringify(destination),
  });
}

export function deleteCampaignDestination(id: number): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`campaign/destinations/${id}`, {
    method: 'DELETE',
  });
}

// Enables exactly this destination and disables all others ("promote only X now")
export function focusCampaignDestination(
  id: number,
): Promise<{ success: boolean; campaign: AutomationCampaign }> {
  return request<{ success: boolean; campaign: AutomationCampaign }>('campaign/destinations/focus', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

export interface CampaignLinkStats {
  id: number;
  url: string;
  totalSends: number;
  last24hSends: number;
  resolvedTitle?: string;
  resolvedMembers?: number;
  resolvedAbout?: string;
  resolvedAt?: number;
  resolvedFailed?: boolean;
  membersDelta?: number;
}

export function fetchCampaignLinkStats(): Promise<CampaignLinkStats[]> {
  return request<CampaignLinkStats[]>('campaign/links/stats');
}

export function resolveCampaignLink(
  id: number,
): Promise<{ success: boolean; resolved: ResolveInviteResult }> {
  return request('campaign/links/resolve', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

export function sendCampaignTestMessage(text: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('campaign/test-send', {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export interface CampaignListItem {
  id: number;
  name: string;
  isActive: boolean;
  updatedAt: number;
}

export function fetchCampaigns(): Promise<CampaignListItem[]> {
  return request<CampaignListItem[]>('campaigns');
}

export function createCampaign(name: string): Promise<{ success: boolean; id: number }> {
  return request<{ success: boolean; id: number }>('campaign/create', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

export function duplicateCampaign(id: number, name?: string): Promise<{ success: boolean; id: number }> {
  return request<{ success: boolean; id: number }>('campaign/duplicate', {
    method: 'POST',
    body: JSON.stringify({ id, name }),
  });
}

export function renameCampaign(id: number, name: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>('campaign/rename', {
    method: 'POST',
    body: JSON.stringify({ id, name }),
  });
}

export function activateCampaign(id: number): Promise<{ success: boolean; campaign: AutomationCampaign }> {
  return request<{ success: boolean; campaign: AutomationCampaign }>('campaign/activate', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
}

export interface CampaignPerformanceTemplate {
  id: number;
  title: string;
  attempts: number;
  successes: number;
  errors: number;
  floodWaits: number;
  skips: number;
  successRate?: number;
}

export interface CampaignPerformance {
  since: number;
  templates: CampaignPerformanceTemplate[];
  hourly: { bucket: number; count: number }[];
  topGroups: { chatId: string; chatTitle: string; attempts: number; successes: number }[];
  links: {
    id: number;
    url: string;
    resolvedMembers?: number;
    snapshots: { members: number; checkedAt: number }[];
  }[];
}

export function fetchCampaignPerformance(): Promise<CampaignPerformance> {
  return request<CampaignPerformance>('campaign/performance');
}

export function fetchAutomationGroups(): Promise<AutomationGroupState[]> {
  return request<AutomationGroupState[]>('groups');
}

export function fetchAutomationLogs(limit = 50): Promise<AutomationLogItem[]> {
  return request<AutomationLogItem[]>(`logs?limit=${limit}`);
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

export interface OrchestratorAccountInfo {
  userId: string;
  username?: string;
  firstName?: string;
}

// Read-only digest of the effective rhythm each account reports in its
// heartbeat (local values merged with the global overrides)
export interface OrchestratorConfigDigest {
  mode: 'manual' | 'continuous';
  minDelaySeconds: number;
  maxDelaySeconds: number;
  roundIntervalMinutes: number;
  roundTargetSends: number;
  minOtherMessages: number;
  minResendIntervalMinutes: number;
  dailyLimit: number;
  sleepWindowEnabled: boolean;
  sleepWindowStart: string;
  sleepWindowEnd: string;
}

export interface OrchestratorPendingCommand {
  id: string;
  type: 'start' | 'stop' | 'campaign-copy';
  issuedAt: number;
}

export interface OrchestratorCommandAck {
  id: string;
  ok: boolean;
  message?: string;
  error?: string;
  at: number;
}

// When the worker daemon is directly reachable the master executes start/stop
// in the same request and returns the outcome; otherwise the command rides
// the heartbeat channel and `result` is absent
export interface SendOrchestratorCommandResult {
  success: boolean;
  command: { id: string; type: string };
  result?: OrchestratorCommandAck;
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
    account?: OrchestratorAccountInfo;
    configDigest?: OrchestratorConfigDigest;
    overriddenFields?: string[];
  };
  metaTarget?: number;
  lastHeartbeatAt: number;
  isAlive?: boolean;
  pendingCommand?: OrchestratorPendingCommand;
  lastCommandAck?: OrchestratorCommandAck;
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

export type OrchestratorOverrideValue = string | number | boolean;
export type OrchestratorOverrides = Record<string, OrchestratorOverrideValue>;

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

export function fetchOrchestratorOverrides(): Promise<{ overrides: OrchestratorOverrides }> {
  return requestOrchestrator<{ overrides: OrchestratorOverrides }>('overrides');
}

// Sparse patch: `set` defines/replaces fields, `clear` removes them so every
// account falls back to its own local value
export function updateOrchestratorOverrides(patch: {
  set?: Record<string, OrchestratorOverrideValue>;
  clear?: string[];
}): Promise<{ overrides: OrchestratorOverrides }> {
  return requestOrchestrator<{ overrides: OrchestratorOverrides }>('overrides', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

// Issues a command to a single account; execution still requires the account
// to ack it, so the action is per-account and never batched
export function sendOrchestratorCommand(
  workerId: string,
  type: 'start' | 'stop' | 'campaign-copy',
  payload?: unknown,
): Promise<SendOrchestratorCommandResult> {
  return requestOrchestrator<SendOrchestratorCommandResult>(
    'workers/command',
    {
      method: 'POST',
      body: JSON.stringify(payload === undefined ? { workerId, type } : { workerId, type, payload }),
    },
  );
}

// Content-only campaign projection: local row ids never leave the origin
// account — the target rebuilds rows with its own ids on apply
export interface OrchestratorCampaignCopyPayload {
  templates: { title?: string; content: string; weight?: number; isEnabled?: boolean }[];
  links: { url: string; isEnabled?: boolean; destinationIndex?: number }[];
  destinations?: { name: string; weight?: number; isEnabled?: boolean }[];
}

export function buildCampaignCopyPayload(campaign: AutomationCampaign): OrchestratorCampaignCopyPayload {
  const destinationIndexById = new Map(
    campaign.destinations.map((destination, index) => [destination.id, index]),
  );
  return {
    templates: campaign.templates.map((template) => ({
      title: template.title,
      content: template.content,
      weight: template.weight,
      isEnabled: template.isEnabled,
    })),
    links: campaign.allLinks.map((link) => ({
      url: link.url,
      isEnabled: link.isEnabled,
      destinationIndex: link.destinationId !== undefined
        ? destinationIndexById.get(link.destinationId)
        : undefined,
    })),
    destinations: campaign.destinations.map((destination) => ({
      name: destination.name,
      weight: destination.weight,
      isEnabled: destination.isEnabled,
    })),
  };
}
