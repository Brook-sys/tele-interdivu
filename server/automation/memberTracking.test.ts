import { describe, expect, it } from 'vitest';

import { AutomationDatabase } from '../db/database';
import { runMemberTrackingTick } from './memberTracking';

const RESOLVED_CHANNEL = { title: 'Canal A', members: 100, chatType: 'channel' };

describe('runMemberTrackingTick', () => {
  it('does nothing while tracking is disabled (default)', async () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;
    const link = db.saveCampaignLink({ campaignId, url: 'https://t.me/canal_a' });

    await runMemberTrackingTick(
      db,
      () => { throw new Error('resolver must not be called while disabled'); },
      () => true,
      1,
    );

    expect(db.getLinkLastCheckedAt(link.id)).toBeUndefined();
    db.close();
  });

  it('does nothing while the runner is disconnected', async () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;
    db.saveCampaignLink({ campaignId, url: 'https://t.me/canal_a' });
    db.updateConfig({ memberTrackingEnabled: true });

    await runMemberTrackingTick(
      db,
      () => { throw new Error('resolver must not be called while disconnected'); },
      () => false,
      1,
    );

    expect(db.getLinkUsageStats()).toEqual([]);
    db.close();
  });

  it('checks due t.me links only, stores resolution and snapshot', async () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;
    const linkA = db.saveCampaignLink({ campaignId, url: 'https://t.me/canal_a' });
    const linkB = db.saveCampaignLink({ campaignId, url: 'https://t.me/+hashB' });
    db.saveCampaignLink({ campaignId, url: 'https://instagram.com/not-trackable' });
    db.saveCampaignLink({ campaignId, url: 'https://t.me/canal-off', isEnabled: false });
    db.updateConfig({ memberTrackingEnabled: true });

    const resolvedUrls: string[] = [];
    await runMemberTrackingTick(db, (url) => {
      resolvedUrls.push(url);
      return Promise.resolve(RESOLVED_CHANNEL);
    }, () => true, 1);

    expect(resolvedUrls).toEqual(['https://t.me/canal_a', 'https://t.me/+hashB']);

    const campaign = db.getCampaign();
    const linkARecord = campaign.allLinks.find((l) => l.id === linkA.id);
    expect(linkARecord?.resolvedTitle).toBe('Canal A');
    expect(linkARecord?.resolvedMembers).toBe(100);
    expect(linkARecord?.resolvedFailed).toBe(false);

    const snapshots = db.getLinkSnapshots(linkA.id);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].members).toBe(100);
    expect(db.getLinkSnapshots(linkB.id)).toHaveLength(1);
    db.close();
  });

  it('skips links checked recently on the next tick', async () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;
    db.saveCampaignLink({ campaignId, url: 'https://t.me/canal_a' });
    db.updateConfig({ memberTrackingEnabled: true });

    const resolvedUrls: string[] = [];
    const resolver = (url: string) => {
      resolvedUrls.push(url);
      return Promise.resolve(RESOLVED_CHANNEL);
    };

    await runMemberTrackingTick(db, resolver, () => true, 1);
    const firstCount = resolvedUrls.length;
    await runMemberTrackingTick(db, resolver, () => true, 1);

    expect(firstCount).toBe(1);
    expect(resolvedUrls).toHaveLength(1);
    db.close();
  });

  it('marks dead destinations as failed without killing the pass', async () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;
    const dead = db.saveCampaignLink({ campaignId, url: 'https://t.me/+expired' });
    const alive = db.saveCampaignLink({ campaignId, url: 'https://t.me/canal_a' });
    db.updateConfig({ memberTrackingEnabled: true });

    const resolvedUrls: string[] = [];
    await runMemberTrackingTick(db, (url) => {
      resolvedUrls.push(url);
      if (url.includes('expired')) {
        return Promise.reject(Object.assign(
          new Error('INVITE_HASH_EXPIRED'),
          { errorMessage: 'INVITE_HASH_EXPIRED' },
        ));
      }
      return Promise.resolve(RESOLVED_CHANNEL);
    }, () => true, 1);

    expect(resolvedUrls).toHaveLength(2);

    const campaign = db.getCampaign();
    expect(campaign.allLinks.find((l) => l.id === dead.id)?.resolvedFailed).toBe(true);
    expect(campaign.allLinks.find((l) => l.id === alive.id)?.resolvedTitle).toBe('Canal A');
    db.close();
  });
});
