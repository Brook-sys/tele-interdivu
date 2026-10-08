import type http from 'node:http';
import { URL } from 'node:url';

import type { TargetChatInfo, TelegramRunner } from '../automation/telegramRunner';
import type { AutomationDatabase } from '../db/database';

import { FloodWaitActiveError } from '../automation/resolveGuard';
import { type AutomationScheduler, evaluateGroupEligibility } from '../automation/scheduler';
import { compileSpunMessage, validateSpintaxSyntax } from '../automation/spintax';
import { parseCampaignLinkTarget } from '../automation/telegramRunner';
import { readJsonBody, sendError, sendJson } from './httpHelper';

// Server-side guard against accidental double clicks on the test-send button
const TEST_SEND_COOLDOWN_MS = 15_000;
let lastTestSendAt = 0;

export interface AutomationStartResult {
  success: boolean;
  message: string;
  groupsCount?: number;
  usedSavedSession?: boolean;
}

// Restarts the automation from the daemon's own saved state (saved session +
// group_state targets) — the same path the web UI takeover uses when invoked
// with no body. Used by the takeover route and by the orchestrator command
// channel, so a remote start reuses the exact session the account armed once
export async function startAutomationFromSavedState(
  db: AutomationDatabase,
  runner: TelegramRunner,
  scheduler: AutomationScheduler,
): Promise<AutomationStartResult> {
  const savedSession = db.getSession();
  if (!savedSession) {
    return {
      success: false,
      message: 'No sessionData provided and no saved session found — start from the web UI first',
    };
  }
  let sessionData: any;
  try {
    sessionData = JSON.parse(savedSession);
  } catch {
    return { success: false, message: 'Saved session is corrupted — start from the web UI again' };
  }
  const targetChats = db.getAllGroupStates().map((g) => ({
    id: g.chatId,
    title: g.title,
    accessHash: g.accessHash,
  }));
  if (!targetChats.length) {
    return { success: false, message: 'No targetChats provided and no groups saved — start from the web UI first' };
  }
  scheduler.stop();
  await runner.start(sessionData, targetChats);
  scheduler.start();
  return {
    success: true,
    message: 'Automation started from saved state',
    groupsCount: targetChats.length,
    usedSavedSession: true,
  };
}

export async function stopAutomation(runner: TelegramRunner, scheduler: AutomationScheduler) {
  scheduler.stop();
  await runner.stop();
}

export function createApiHandler(
  db: AutomationDatabase,
  runner: TelegramRunner,
  scheduler: AutomationScheduler,
) {
  return async (req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> => {
    const parsedUrl = new URL(req.url || '/', 'http://localhost');
    const pathname = parsedUrl.pathname;
    const method = (req.method || 'GET').toUpperCase();

    // CORS preflight
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return true;
    }

    if (!pathname.startsWith('/api/v1/automation/')) {
      return false;
    }

    // Optional bearer token: when AUTOMATION_API_TOKEN is set, every API
    // consumer (including the web UI, which sends it via Authorization after
    // reading ?automationToken= from the URL once) must authenticate.
    const apiToken = process.env.AUTOMATION_API_TOKEN;
    if (apiToken && req.headers.authorization !== `Bearer ${apiToken}`) {
      sendError(res, 401, 'Unauthorized: provide "Authorization: Bearer <AUTOMATION_API_TOKEN>"');
      return true;
    }

    const route = pathname.replace('/api/v1/automation/', '');

    try {
      // 1. GET status
      if (route === 'status' && method === 'GET') {
        const schedulerState = scheduler.getState();
        // Effective config: local values merged with the global overrides the
        // master defined — this is what the scheduler actually runs with.
        // `configOverriddenFields` lets the UI badge those fields
        const config = db.getEffectiveConfig();
        const configOverriddenFields = db.getOverriddenFields();
        const campaign = db.getCampaign();
        const serverNow = Math.floor(Date.now() / 1000);
        const todaySent = db.getTodaySentCount(serverNow);
        const groups = db.getAllGroupStates();

        let readyCount = 0;
        let waitingSlowmodeCount = 0;
        let waitingMessagesCount = 0;
        let blockedCount = 0;
        let starsCount = 0;

        for (const g of groups) {
          const evalResult = evaluateGroupEligibility(
            g, config.minOtherMessages, serverNow, config.minResendIntervalMinutes,
          );
          if (evalResult.reason === 'READY') readyCount++;
          else if (evalResult.reason === 'WAITING_SLOWMODE'
            || evalResult.reason === 'WAITING_RESEND') {
            waitingSlowmodeCount++;
          } else if (evalResult.reason === 'WAITING_MESSAGES') waitingMessagesCount++;
          else if (evalResult.reason === 'STARS') starsCount++;
          else if (evalResult.reason === 'BLOCKED') blockedCount++;
        }

        const validGroupsCount = groups.filter((g) => (
          g.status !== 'BLOCKED'
          && g.status !== 'STARS'
          && (g.starsCost || 0) === 0
        )).length;

        const stats = {
          todaySent,
          dailyLimit: config.dailyLimit,
          totalGroups: validGroupsCount,
          readyCount,
          waitingSlowmodeCount,
          waitingMessagesCount,
          blockedCount,
          starsCount,
        };

        const isRunning = schedulerState.status === 'RUNNING'
          || schedulerState.status === 'WAITING_NEXT_ROUND'
          || schedulerState.status === 'WAITING_COOLDOWN'
          || schedulerState.status === 'WAITING_MESSAGES'
          || schedulerState.status === 'MICRO_PAUSE'
          || schedulerState.status === 'SLEEP_WINDOW'
          || schedulerState.status === 'CIRCUIT_BREAKER';

        sendJson(res, 200, {
          isRunning,
          status: schedulerState.status,
          waitingReason: schedulerState.waitingReason,
          isTelegramConnected: runner.getIsConnected(),
          currentChatId: schedulerState.currentChatId,
          currentChatTitle: schedulerState.currentChatTitle,
          nextRunAt: schedulerState.nextRunAt,
          sleepUntil: schedulerState.sleepUntil,
          waitTotalUntil: schedulerState.waitTotalUntil ?? schedulerState.sleepUntil,
          activeRound: schedulerState.activeRound,
          sentInRoundCount: schedulerState.sentInRoundCount,
          lastError: schedulerState.lastRunError,
          stats,
          config,
          configOverriddenFields,
          campaign,
        });
        return true;
      }

      // 2. POST takeover (Frontend hands over session and targets to daemon)
      // Remote start: sessionData and targetChats are optional — when omitted,
      // the daemon reuses the saved session and the group_state table as
      // targets, so the automation can be restarted purely via the API.
      if (route === 'takeover' && method === 'POST') {
        const body = await readJsonBody<{
          sessionData?: any;
          targetChats?: (TargetChatInfo & {
            slowmodeSeconds?: number;
            slowmodeNextSendDate?: number;
            lastSentAt?: number;
            starsCost?: number;
            status?: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' | 'STARS' | 'SENT';
          })[];
        }>(req);

        // Persist what the request provided; the start mechanics below then
        // resolve whatever is still missing from saved state
        if (body.sessionData) {
          db.saveSession(JSON.stringify(body.sessionData));
        }

        if (body.targetChats && Array.isArray(body.targetChats) && body.targetChats.length > 0) {
          // Sync target groups in group_state — removes any old/deleted chats
          const validChatIds = body.targetChats.map((c) => c.id);
          db.syncTargetGroups(validChatIds);

          body.targetChats.forEach((chat) => {
            const existing = db.getGroupState(chat.id);
            const slowmodeSeconds = chat.slowmodeSeconds !== undefined
              ? chat.slowmodeSeconds
              : (existing?.slowmodeSeconds ?? 0);
            const slowmodeNextSendDate = chat.slowmodeNextSendDate !== undefined
              ? chat.slowmodeNextSendDate
              : existing?.slowmodeNextSendDate;
            const lastSentAt = chat.lastSentAt !== undefined ? chat.lastSentAt : existing?.lastSentAt;
            const starsCost = chat.starsCost !== undefined ? chat.starsCost : (existing?.starsCost ?? 0);
            const status = (starsCost > 0 || chat.status === 'STARS')
              ? 'STARS'
              : (chat.status || (existing?.status ?? 'READY'));

            db.upsertGroupState({
              chatId: chat.id,
              title: chat.title,
              accessHash: chat.accessHash,
              otherMessagesCount: existing ? existing.otherMessagesCount : 0,
              slowmodeSeconds,
              slowmodeNextSendDate,
              starsCost,
              lastSentAt,
              status,
            });
          });
        }

        const result = await startAutomationFromSavedState(db, runner, scheduler);
        if (!result.success) {
          sendError(res, 400, result.message);
          return true;
        }

        sendJson(res, 200, {
          success: true,
          message: 'Automation takeover successful',
          groupsCount: result.groupsCount,
          usedSavedSession: !body.sessionData,
        });
        return true;
      }

      // 3. POST release (User pauses/stops automation, reclaiming session for browser)
      if (route === 'release' && method === 'POST') {
        await stopAutomation(runner, scheduler);

        sendJson(res, 200, { success: true, message: 'Automation stopped and session released' });
        return true;
      }

      // 4. GET & POST config
      if (route === 'config') {
        if (method === 'GET') {
          sendJson(res, 200, db.getConfig());
          return true;
        }
        if (method === 'POST') {
          const patch = await readJsonBody<any>(req);
          const updated = db.updateConfig(patch);
          runner.setExtractorEnabled(updated.extractorEnabled);
          sendJson(res, 200, updated);
          return true;
        }
      }

      // 4b. Extractor: links extracted passively from target group messages
      if (route === 'extract/links' && method === 'GET') {
        const items = db.getExtractedItems({
          kind: parsedUrl.searchParams.get('kind') || undefined,
          query: parsedUrl.searchParams.get('q') || undefined,
          limit: parsedUrl.searchParams.get('limit')
            ? Number(parsedUrl.searchParams.get('limit')) : undefined,
          orderBy: parsedUrl.searchParams.get('sort') === 'seen' ? 'times_seen' : 'last_seen_at',
        });
        sendJson(res, 200, items);
        return true;
      }

      if (route === 'extract/stats' && method === 'GET') {
        sendJson(res, 200, {
          enabled: db.getConfig().extractorEnabled,
          byKind: db.getExtractStats(),
        });
        return true;
      }

      if (route === 'extract/export' && method === 'GET') {
        const kind = parsedUrl.searchParams.get('kind') || undefined; // omitted = all kinds
        const items = db.getExtractedItems({ kind, limit: 5000 });

        const toIso = (epoch?: number) => (epoch ? new Date(epoch * 1000).toISOString() : '');
        if (parsedUrl.searchParams.get('format') === 'csv') {
          const escapeCsv = (v?: string | number) => `"${String(v ?? '').replace(/"/g, '""')}"`;
          const header = [
            'kind', 'value', 'resolved_title', 'resolved_members', 'resolved_type',
            'resolved_about', 'source_chat', 'first_seen', 'last_seen', 'times_seen',
          ].join(',') + '\n';
          const lines = items.map((item) => [
            item.kind,
            item.value,
            item.resolvedTitle,
            item.resolvedMembers,
            item.resolvedType,
            item.resolvedAbout,
            item.sourceChatTitle,
            toIso(item.firstSeenAt),
            toIso(item.lastSeenAt),
            item.timesSeen,
          ].map(escapeCsv).join(',')).join('\n');
          const body = `\uFEFF${header}${lines}\n`; // BOM so Excel reads UTF-8
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="extracted-${kind || 'all'}.csv"`,
            'Access-Control-Allow-Origin': '*',
          });
          res.end(body);
          return true;
        }

        const body = items.map((item) => item.value).join('\n');
        res.writeHead(200, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="extracted-${kind || 'all'}.txt"`,
          'Access-Control-Allow-Origin': '*',
        });
        res.end(body);
        return true;
      }

      if (route === 'extract/clear' && method === 'POST') {
        const body = await readJsonBody<{ kind?: string }>(req);
        db.clearExtractedItems(body.kind);
        sendJson(res, 200, { success: true });
        return true;
      }

      // Resolves an extracted link destination (read-only; invite links only)
      if (route === 'extract/resolve' && method === 'POST') {
        const body = await readJsonBody<{ kind?: string; value?: string }>(req);
        if (!body.value || body.kind !== 'invite_link') {
          sendError(res, 400, 'kind=invite_link and value are required');
          return true;
        }

        const match = body.value.match(/t\.me\/(?:\+|joinchat\/)([A-Za-z0-9_-]+)/);
        if (!match) {
          sendError(res, 400, 'Not a resolvable Telegram invite link');
          return true;
        }

        if (!runner.getIsConnected()) {
          sendError(res, 503, 'Daemon is not connected to Telegram right now — try again in a few seconds');
          return true;
        }

        try {
          const resolved = await runner.resolveInviteLink(match[1]);
          if (!resolved) {
            sendError(res, 503, 'Daemon not connected');
            return true;
          }

          db.markExtractedResolved(body.kind, body.value, {
            title: resolved.title,
            members: resolved.members,
            type: resolved.chatType,
            photoB64: resolved.photoB64,
            about: resolved.about,
          });
          sendJson(res, 200, { success: true, resolved });
          return true;
        } catch (err: any) {
          if (err instanceof FloodWaitActiveError) {
            sendError(res, 429, err.message);
            return true;
          }
          const message = String(err?.errorMessage || err?.message || err);
          if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID/.test(message)) {
            db.markExtractedResolved(body.kind, body.value, { failed: true });
            sendError(res, 410, 'Convite expirado ou inválido (registrado)');
            return true;
          }
          throw err;
        }
      }

      // 5. GET & POST campaign
      if (route === 'campaign') {
        if (method === 'GET') {
          sendJson(res, 200, db.getCampaign());
          return true;
        }
        if (method === 'POST') {
          const body = await readJsonBody<{ spintaxTemplate: string; links: string[] }>(req);
          const validation = validateSpintaxSyntax(body.spintaxTemplate || '');
          if (!validation.isValid) {
            sendError(res, 400, `Spintax syntax error: ${validation.error}`);
            return true;
          }
          const saved = db.saveCampaign(body.spintaxTemplate || '', body.links || []);
          sendJson(res, 200, saved);
          return true;
        }
      }

      // 5b. POST campaign/templates — upsert a template of the active campaign
      if (route === 'campaign/templates' && method === 'POST') {
        const body = await readJsonBody<{
          id?: number;
          title?: string;
          content: string;
          weight?: number;
          isEnabled?: boolean;
        }>(req);
        const validation = validateSpintaxSyntax(body.content || '');
        if (!validation.isValid) {
          sendError(res, 400, `Spintax syntax error: ${validation.error}`);
          return true;
        }
        const saved = db.saveCampaignTemplate({
          id: body.id,
          campaignId: db.getCampaign().id,
          title: body.title,
          content: body.content,
          weight: body.weight,
          isEnabled: body.isEnabled,
        });
        sendJson(res, 200, saved);
        return true;
      }

      // 5c. DELETE campaign/templates/{id}
      if (route.startsWith('campaign/templates/') && method === 'DELETE') {
        const id = Number(route.slice('campaign/templates/'.length));
        if (!id) {
          sendError(res, 400, 'Invalid template id');
          return true;
        }
        db.deleteCampaignTemplate(id);
        sendJson(res, 200, { success: true, deleted: id });
        return true;
      }

      // 5d. POST campaign/links — upsert a link of the active campaign
      if (route === 'campaign/links' && method === 'POST') {
        const body = await readJsonBody<{
          id?: number;
          url: string;
          isEnabled?: boolean;
          destinationId?: number;
        }>(req);
        if (!body.url || !body.url.trim()) {
          sendError(res, 400, 'url is required');
          return true;
        }
        const campaign = db.getCampaign();
        if (body.destinationId !== undefined
          && !campaign.destinations.some((destination) => destination.id === body.destinationId)) {
          sendError(res, 400, 'destinationId does not belong to the active campaign');
          return true;
        }
        const saved = db.saveCampaignLink({
          id: body.id,
          campaignId: campaign.id,
          url: body.url.trim(),
          isEnabled: body.isEnabled,
          destinationId: body.destinationId,
        });
        sendJson(res, 200, saved);
        return true;
      }

      // 5e. DELETE campaign/links/{id}
      if (route.startsWith('campaign/links/') && method === 'DELETE') {
        const id = Number(route.slice('campaign/links/'.length));
        if (!id) {
          sendError(res, 400, 'Invalid link id');
          return true;
        }
        db.deleteCampaignLink(id);
        sendJson(res, 200, { success: true, deleted: id });
        return true;
      }

      // 5e2. POST campaign/destinations — upsert a destination of the active campaign
      if (route === 'campaign/destinations' && method === 'POST') {
        const body = await readJsonBody<{
          id?: number;
          name?: string;
          weight?: number;
          isEnabled?: boolean;
        }>(req);
        if (!body.id && !body.name?.trim()) {
          sendError(res, 400, 'name is required when creating a destination');
          return true;
        }
        const campaign = db.getCampaign();
        if (body.id && !campaign.destinations.some((destination) => destination.id === body.id)) {
          sendError(res, 404, 'Destination not found in the active campaign');
          return true;
        }
        const saved = db.saveDestination({
          id: body.id,
          campaignId: campaign.id,
          name: body.name?.trim(),
          weight: body.weight,
          isEnabled: body.isEnabled,
        });
        sendJson(res, 200, saved);
        return true;
      }

      // 5e3. DELETE campaign/destinations/{id} — links become loose
      if (route.startsWith('campaign/destinations/') && method === 'DELETE') {
        const id = Number(route.slice('campaign/destinations/'.length));
        if (!id) {
          sendError(res, 400, 'Invalid destination id');
          return true;
        }
        db.deleteCampaignDestination(id);
        sendJson(res, 200, { success: true, deleted: id });
        return true;
      }

      // 5e4. POST campaign/destinations/focus — promote only this destination
      // (enables it and disables all others of the campaign, atomically)
      if (route === 'campaign/destinations/focus' && method === 'POST') {
        const body = await readJsonBody<{ id: number }>(req);
        if (!body.id) {
          sendError(res, 400, 'id is required');
          return true;
        }
        const applied = db.focusDestination(Number(body.id));
        if (!applied) {
          sendError(res, 404, 'Destination not found');
          return true;
        }
        sendJson(res, 200, { success: true, campaign: db.getCampaign() });
        return true;
      }

      // 5f. POST campaign/links/resolve — check a link destination now
      // (read-only resolution; one click = one check)
      if (route === 'campaign/links/resolve' && method === 'POST') {
        const body = await readJsonBody<{ id: number }>(req);
        const link = db.getCampaign().allLinks.find((l) => l.id === Number(body.id));
        if (!link) {
          sendError(res, 404, 'Link not found');
          return true;
        }
        if (!parseCampaignLinkTarget(link.url)) {
          sendError(res, 400, 'Only t.me links (invite or public) can be resolved');
          return true;
        }
        if (!runner.getIsConnected()) {
          sendError(res, 503, 'Daemon is not connected to Telegram right now — try again in a few seconds');
          return true;
        }

        try {
          const resolved = await runner.resolveCampaignLink(link.url);
          if (!resolved) {
            sendError(res, 503, 'Daemon not connected');
            return true;
          }
          db.markCampaignLinkResolved(link.id, {
            title: resolved.title,
            members: resolved.members,
            type: resolved.chatType,
            photoB64: resolved.photoB64,
            about: resolved.about,
          });
          if (resolved.members !== undefined) {
            db.addLinkSnapshot(link.id, resolved.members);
          }
          sendJson(res, 200, { success: true, resolved });
          return true;
        } catch (err: any) {
          if (err instanceof FloodWaitActiveError) {
            sendError(res, 429, err.message);
            return true;
          }
          const message = String(err?.errorMessage || err?.message || err);
          if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|USERNAME_NOT_FOUND|USERNAME_INVALID/.test(message)) {
            db.markCampaignLinkResolved(link.id, { failed: true });
            sendError(res, 410, 'Link inválido, expirado ou destino não existe (registrado)');
            return true;
          }
          throw err;
        }
      }

      // 5g. GET campaign/links/stats — usage per link + member snapshots
      if (route === 'campaign/links/stats' && method === 'GET') {
        const campaign = db.getCampaign();
        const usageByUrl = new Map(db.getLinkUsageStats().map((u) => [u.url, u]));
        const stats = campaign.allLinks.map((link) => {
          const usage = usageByUrl.get(link.url);
          const snapshots = db.getLinkSnapshots(link.id, 2);
          const membersDelta = snapshots.length === 2
            ? snapshots[0].members - snapshots[1].members : undefined;
          return {
            id: link.id,
            url: link.url,
            totalSends: usage?.total ?? 0,
            last24hSends: usage?.last24h ?? 0,
            resolvedTitle: link.resolvedTitle,
            resolvedMembers: link.resolvedMembers,
            resolvedAbout: link.resolvedAbout,
            resolvedAt: link.resolvedAt,
            resolvedFailed: link.resolvedFailed,
            membersDelta,
          };
        });
        sendJson(res, 200, stats);
        return true;
      }

      // 5i. Named campaigns management
      if (route === 'campaigns' && method === 'GET') {
        sendJson(res, 200, db.getCampaigns());
        return true;
      }
      if (route === 'campaign/create' && method === 'POST') {
        const body = await readJsonBody<{ name?: string }>(req);
        const id = db.createCampaign((body.name || '').trim() || `Campanha ${db.getCampaigns().length + 1}`);
        sendJson(res, 200, { success: true, id });
        return true;
      }
      if (route === 'campaign/duplicate' && method === 'POST') {
        const body = await readJsonBody<{ id: number; name?: string }>(req);
        if (!body.id) {
          sendError(res, 400, 'id is required');
          return true;
        }
        const id = db.duplicateCampaign(Number(body.id), (body.name || '').trim());
        sendJson(res, 200, { success: true, id });
        return true;
      }
      if (route === 'campaign/rename' && method === 'POST') {
        const body = await readJsonBody<{ id: number; name: string }>(req);
        if (!body.id || !body.name?.trim()) {
          sendError(res, 400, 'id and name are required');
          return true;
        }
        db.renameCampaign(Number(body.id), body.name.trim());
        sendJson(res, 200, { success: true });
        return true;
      }
      if (route === 'campaign/activate' && method === 'POST') {
        const body = await readJsonBody<{ id: number }>(req);
        if (!body.id) {
          sendError(res, 400, 'id is required');
          return true;
        }
        const campaigns = db.getCampaigns();
        if (!campaigns.some((c) => c.id === Number(body.id))) {
          sendError(res, 404, 'Campaign not found');
          return true;
        }
        db.activateCampaign(Number(body.id));
        sendJson(res, 200, { success: true, campaign: db.getCampaign() });
        return true;
      }

      // 5j. GET campaign/performance — logs-based dashboard aggregates
      // (zero Telegram activity, pure DB reads)
      if (route === 'campaign/performance' && method === 'GET') {
        const now = Math.floor(Date.now() / 1000);
        const sinceWeek = now - 7 * 86_400;
        const since48h = now - 48 * 3_600;

        const campaign = db.getCampaign();
        const templateStats = db.getTemplateStats(sinceWeek);

        const templates = campaign.templates.map((template) => {
          const rows = templateStats.filter((row) => row.templateId === template.id);
          const attempts = rows.reduce((sum, row) => sum + row.count, 0);
          const successes = rows
            .filter((row) => row.status === 'SUCCESS')
            .reduce((sum, row) => sum + row.count, 0);
          const errors = rows
            .filter((row) => row.status === 'ERROR')
            .reduce((sum, row) => sum + row.count, 0);
          const floodWaits = rows
            .filter((row) => row.status === 'FLOOD_WAIT')
            .reduce((sum, row) => sum + row.count, 0);
          const skips = rows
            .filter((row) => row.status === 'SKIPPED')
            .reduce((sum, row) => sum + row.count, 0);
          return {
            id: template.id,
            title: template.title || template.content.slice(0, 30),
            attempts,
            successes,
            errors,
            floodWaits,
            skips,
            successRate: attempts ? Math.round((successes / attempts) * 100) : undefined,
          };
        });

        const hourlyRaw = db.getHourlySuccess(since48h);
        const hourlyMap = new Map(hourlyRaw.map((row) => [row.bucket, row.count]));
        const hourly: { bucket: number; count: number }[] = [];
        const firstBucket = Math.ceil(since48h / 3600) * 3600;
        for (let bucket = firstBucket; bucket <= now; bucket += 3600) {
          hourly.push({ bucket, count: hourlyMap.get(bucket) ?? 0 });
        }

        const links = campaign.allLinks.map((link) => ({
          id: link.id,
          url: link.url,
          resolvedMembers: link.resolvedMembers,
          snapshots: db.getLinkSnapshots(link.id, 30),
        }));

        sendJson(res, 200, {
          since: sinceWeek,
          templates,
          hourly,
          topGroups: db.getChatStats(sinceWeek),
          links,
        });
        return true;
      }

      // 5h. POST campaign/test-send — one real message to Saved Messages
      // so the user sees exactly how the content renders (1 per cooldown)
      if (route === 'campaign/test-send' && method === 'POST') {
        const body = await readJsonBody<{ text: string }>(req);
        if (!body.text || !body.text.trim()) {
          sendError(res, 400, 'text is required');
          return true;
        }
        const now = Date.now();
        if (now - lastTestSendAt < TEST_SEND_COOLDOWN_MS) {
          sendError(res, 429, 'Aguarde alguns segundos antes de enviar outro teste');
          return true;
        }
        if (!runner.getIsConnected()) {
          sendError(res, 503, 'Daemon is not connected to Telegram right now — try again in a few seconds');
          return true;
        }

        const result = await runner.sendTestMessage(body.text);
        if (!result.success) {
          sendError(res, 502, result.error);
          return true;
        }
        lastTestSendAt = now;
        sendJson(res, 200, { success: true });
        return true;
      }

      // 6. GET groups
      if (route === 'groups' && method === 'GET') {
        const config = db.getConfig();
        const serverNow = Math.floor(Date.now() / 1000);
        const groups = db.getAllGroupStates();

        const evaluatedGroups = groups.map((g) => {
          const evalResult = evaluateGroupEligibility(
            g, config.minOtherMessages, serverNow, config.minResendIntervalMinutes,
          );
          return {
            ...g,
            status: evalResult.reason,
          };
        });

        sendJson(res, 200, evaluatedGroups.map(({ accessHash, ...rest }) => rest));
        return true;
      }

      // 6b. POST groups/{chatId} — add or update a group remotely
      // (e.g. quarantine with {status:'BLOCKED'} or reintegrate with
      // {status:'READY'}; accessHash is required for brand-new chats)
      if (route.startsWith('groups/') && method === 'POST') {
        const chatId = decodeURIComponent(route.slice('groups/'.length));
        const body = await readJsonBody<{
          title?: string;
          accessHash?: string;
          status?: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' | 'STARS' | 'SENT';
          starsCost?: number;
          slowmodeSeconds?: number;
        }>(req);

        const existing = db.getGroupState(chatId);
        if (!existing && !body.accessHash) {
          sendError(res, 400, 'accessHash is required when adding a group that is not saved yet');
          return true;
        }

        db.upsertGroupState({
          chatId,
          title: body.title || existing?.title || `Chat ${chatId}`,
          accessHash: body.accessHash || existing?.accessHash,
          otherMessagesCount: existing?.otherMessagesCount ?? 0,
          slowmodeSeconds: body.slowmodeSeconds ?? existing?.slowmodeSeconds ?? 0,
          slowmodeNextSendDate: existing?.slowmodeNextSendDate,
          starsCost: body.starsCost ?? existing?.starsCost ?? 0,
          lastSentAt: existing?.lastSentAt,
          status: body.status || existing?.status || 'READY',
          lastError: body.status !== undefined ? undefined : existing?.lastError,
        });

        sendJson(res, 200, { success: true, group: db.getGroupState(chatId) });
        return true;
      }

      // 6c. DELETE groups/{chatId} — remove a group from the rotation
      if (route.startsWith('groups/') && method === 'DELETE') {
        const chatId = decodeURIComponent(route.slice('groups/'.length));
        const existing = db.getGroupState(chatId);
        if (!existing) {
          sendError(res, 404, `Group ${chatId} not found`);
          return true;
        }

        db.deleteGroupState(chatId);
        sendJson(res, 200, { success: true, deleted: chatId });
        return true;
      }

      // 7. GET logs
      if (route === 'logs' && method === 'GET') {
        const limitStr = parsedUrl.searchParams.get('limit');
        const limit = limitStr ? Math.min(100, Math.max(1, Number(limitStr))) : 50;
        sendJson(res, 200, db.getRecentLogs(limit));
        return true;
      }

      // 8. POST test-spintax
      if (route === 'test-spintax' && method === 'POST') {
        const body = await readJsonBody<{ template: string; links: string[] }>(req);
        const validation = validateSpintaxSyntax(body.template || '');
        if (!validation.isValid) {
          sendError(res, 400, `Spintax syntax error: ${validation.error}`);
          return true;
        }

        const previews = [];
        for (let i = 0; i < 5; i++) {
          previews.push(compileSpunMessage(body.template || '', body.links || []));
        }

        sendJson(res, 200, { previews });
        return true;
      }

      // 9. POST reset-round
      if (route === 'reset-round' && method === 'POST') {
        scheduler.resetRound();
        sendJson(res, 200, { success: true, message: 'Round counters reset' });
        return true;
      }

      // 9b. POST force-new-round (Clears sent list and starts next round immediately)
      if (route === 'force-new-round' && method === 'POST') {
        scheduler.forceNewRound();
        sendJson(res, 200, { success: true, message: 'Nova rodada iniciada com sucesso' });
        return true;
      }

      // 9c. POST reconnect (Forces Telegram MTProto connection refresh)
      if (route === 'reconnect' && method === 'POST') {
        const ok = await runner.reconnect();
        sendJson(res, 200, { success: ok, message: ok ? 'Reconectado com sucesso' : 'Falha na reconexão' });
        return true;
      }

      // 10. POST skip-pause (Wakes up scheduler from micro-pause or round sleep)
      if (route === 'skip-pause' && method === 'POST') {
        scheduler.skipPause();
        sendJson(res, 200, { success: true, message: 'Pausa pulada com sucesso' });
        return true;
      }

      // 11. GET debug (Comprehensive diagnostics)
      if (route === 'debug' && method === 'GET') {
        const schedulerState = scheduler.getState();
        const config = db.getConfig();
        const serverNow = Math.floor(Date.now() / 1000);
        const groups = db.getAllGroupStates();
        const runnerStats = runner.getStats();

        const evaluatedGroups = groups.map((g) => {
          const evalResult = evaluateGroupEligibility(
            g, config.minOtherMessages, serverNow, config.minResendIntervalMinutes,
          );
          const slowmodeRemaining = g.slowmodeNextSendDate && g.slowmodeNextSendDate > serverNow
            ? g.slowmodeNextSendDate - serverNow : 0;
          return {
            chatId: g.chatId,
            title: g.title,
            status: g.status,
            evaluatedReason: evalResult.reason,
            isEligible: evalResult.isEligible,
            otherMessagesCount: g.otherMessagesCount,
            minOtherMessagesRequired: config.minOtherMessages,
            slowmodeSeconds: g.slowmodeSeconds,
            slowmodeRemaining,
            starsCost: g.starsCost,
            lastSentAt: g.lastSentAt ? new Date(g.lastSentAt * 1000).toISOString() : undefined,
            lastError: g.lastError,
          };
        });

        const sleepRemainingSeconds = schedulerState.sleepUntil && schedulerState.sleepUntil > Date.now()
          ? Math.round((schedulerState.sleepUntil - Date.now()) / 1000) : 0;
        const nextRunRemainingSeconds = schedulerState.nextRunAt && schedulerState.nextRunAt > Date.now()
          ? Math.round((schedulerState.nextRunAt - Date.now()) / 1000) : 0;

        sendJson(res, 200, {
          timestamp: new Date().toISOString(),
          scheduler: {
            ...schedulerState,
            sleepRemainingSeconds,
            nextRunRemainingSeconds,
          },
          connection: runnerStats,
          config,
          groups: evaluatedGroups,
          system: {
            uptime: Math.round(process.uptime()),
            memory: process.memoryUsage(),
            nodeVersion: process.version,
            isProxyConfigured: Boolean(process.env.PROXY_URL),
          },
        });
        return true;
      }

      sendError(res, 404, `Route /api/v1/automation/${route} not found`);
      return true;
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error(`[Automation API] ${method} ${pathname} failed:`, err.stack || err.message);
      sendError(res, 500, `Internal server error (${route}): ${err.message}`);
      return true;
    }
  };
}
