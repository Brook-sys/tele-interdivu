export interface AutomationStatusResponse {
  isRunning: boolean;
  status: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'SLEEP_WINDOW' | 'CIRCUIT_BREAKER' | 'MICRO_PAUSE';
  isTelegramConnected: boolean;
  currentChatId?: string;
  currentChatTitle?: string;
  nextRunAt?: number;
  sleepUntil?: number;
  activeRound: number;
  lastError?: string;
  stats: {
    todaySent: number;
    dailyLimit: number;
    totalGroups: number;
    readyCount: number;
    waitingSlowmodeCount: number;
    waitingMessagesCount: number;
    blockedCount: number;
  };
  config: {
    mode: 'manual' | 'continuous';
    minDelaySeconds: number;
    maxDelaySeconds: number;
    roundIntervalMinutes: number;
    minOtherMessages: number;
    sleepWindowEnabled: boolean;
    sleepWindowStart: string;
    sleepWindowEnd: string;
    dailyLimit: number;
    linkPreviewEnabled: boolean;
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
  status: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' | 'SENT';
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

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api/v1/automation/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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

export function startAutomationTakeover(payload: {
  sessionData: any;
  targetChats: { id: string; title: string; accessHash?: string }[];
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
