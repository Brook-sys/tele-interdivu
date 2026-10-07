import type { AutomationDatabase } from '../db/database';
import type { InviteResolveResult } from './telegramRunner';

import { FloodWaitActiveError } from './resolveGuard';
import { parseCampaignLinkTarget } from './telegramRunner';

const TICK_INTERVAL_MS = 60_000;
// Human-paced delay between consecutive link checks
const LINK_PACING_MS = 4000;

export type CampaignLinkResolver = (url: string) => Promise<InviteResolveResult | undefined>;

// Periodic member-count tracking for promoted links. Opt-in only
// (memberTrackingEnabled, OFF by default): each check is a read-only
// resolution, but it is still account activity, so the loop keeps a
// human-like pacing between links and never runs when disconnected.
// One tracking pass: checks every due link. Exported for tests.
export async function runMemberTrackingTick(
  db: AutomationDatabase,
  resolveLink: CampaignLinkResolver,
  isRunnerConnected: () => boolean,
  pacingMs = LINK_PACING_MS,
) {
  const config = db.getConfig();
  if (!config.memberTrackingEnabled || !isRunnerConnected()) return;

  const campaign = db.getCampaign();
  const trackableLinks = campaign.allLinks.filter(
    (link) => link.isEnabled && parseCampaignLinkTarget(link.url),
  );

  const now = Math.floor(Date.now() / 1000);
  const intervalSec = Math.max(4, config.memberTrackingIntervalHours) * 3600;

  for (const link of trackableLinks) {
    const lastCheckedAt = db.getLinkLastCheckedAt(link.id);
    if (lastCheckedAt && now - lastCheckedAt < intervalSec) continue;

    let resolved: InviteResolveResult | undefined;
    try {
      resolved = await resolveLink(link.url);
    } catch (err: any) {
      // A FLOOD_WAIT window blocks the whole pass; stop here so the loop
      // does not keep poking the API through the wait
      if (err instanceof FloodWaitActiveError) return;
      const message = String(err?.errorMessage || err?.message || err);
      if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|USERNAME_NOT_FOUND|USERNAME_INVALID/.test(message)) {
        db.markCampaignLinkResolved(link.id, { failed: true });
      }
    }
    // Human-like pacing between consecutive checks
    await new Promise((r) => setTimeout(r, pacingMs));

    if (!resolved) continue;

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
  }
}

export function startMemberTrackingLoop(
  db: AutomationDatabase,
  resolveLink: CampaignLinkResolver,
  isRunnerConnected: () => boolean,
): () => void {
  const timer = setInterval(
    () => void runMemberTrackingTick(db, resolveLink, isRunnerConnected).catch(() => {}),
    TICK_INTERVAL_MS,
  );
  (timer as { unref?: () => void }).unref?.();
  // Run one tick shortly after boot so a freshly enabled tracking starts working
  setTimeout(
    () => void runMemberTrackingTick(db, resolveLink, isRunnerConnected).catch(() => {}),
    15_000,
  );

  return () => clearInterval(timer);
}
