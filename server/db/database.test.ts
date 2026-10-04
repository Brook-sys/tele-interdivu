import { describe, expect, it } from 'vitest';

import { AutomationDatabase, DEFAULT_CONFIG } from './database';

describe('AutomationDatabase (in-memory SQLite)', () => {
  it('initializes default config on creation', () => {
    const db = new AutomationDatabase(':memory:');
    const config = db.getConfig();
    expect(config).toEqual(DEFAULT_CONFIG);
    db.close();
  });

  it('updates configuration with partial patch', () => {
    const db = new AutomationDatabase(':memory:');
    const updated = db.updateConfig({
      mode: 'continuous',
      minDelaySeconds: 45,
      dailyLimit: 120,
    });
    expect(updated.mode).toBe('continuous');
    expect(updated.minDelaySeconds).toBe(45);
    expect(updated.dailyLimit).toBe(120);
    expect(updated.maxDelaySeconds).toBe(DEFAULT_CONFIG.maxDelaySeconds);

    const reloaded = db.getConfig();
    expect(reloaded).toEqual(updated);
    db.close();
  });

  it('saves and retrieves campaigns with JSON links', () => {
    const db = new AutomationDatabase(':memory:');
    const links = ['https://t.me/channel1', 'https://t.me/channel2'];
    const template = '{Olá|E aí} veja: {link}';

    const saved = db.saveCampaign(template, links);
    expect(saved.spintaxTemplate).toBe(template);
    expect(saved.links).toEqual(links);

    const retrieved = db.getCampaign();
    expect(retrieved.spintaxTemplate).toBe(template);
    expect(retrieved.links).toEqual(links);
    db.close();
  });

  it('manages multiple templates and links with weights and toggles', () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;

    const templateA = db.saveCampaignTemplate({
      campaignId, title: 'A', content: 'Template A: {LINK}', weight: 3,
    });
    const templateB = db.saveCampaignTemplate({
      campaignId, title: 'B', content: 'Template B: {LINK}',
    });

    const link1 = db.saveCampaignLink({ campaignId, url: 'https://t.me/c1' });
    const link2 = db.saveCampaignLink({ campaignId, url: 'https://t.me/c2' });
    db.saveCampaignLink({ campaignId, id: link2.id, url: 'https://t.me/c2', isEnabled: false });

    const campaign = db.getCampaign();
    expect(campaign.templates.length).toBe(2);
    expect(campaign.templates[0].id).toBe(templateA.id);
    expect(campaign.templates[0].weight).toBe(3);
    expect(campaign.templates[1].id).toBe(templateB.id);
    expect(campaign.allLinks.length).toBe(2);
    expect(campaign.links).toEqual(['https://t.me/c1']);
    expect(campaign.templates.find((t) => t.id === templateB.id)?.isEnabled).toBe(true);

    // Disabling the first template makes the second one the active content
    db.saveCampaignTemplate({
      campaignId, id: templateA.id, title: 'A', content: 'Template A: {LINK}', isEnabled: false,
    });
    expect(db.getCampaign().spintaxTemplate).toBe('Template B: {LINK}');

    db.deleteCampaignTemplate(templateB.id);
    db.deleteCampaignLink(link1.id);
    const afterDelete = db.getCampaign();
    expect(afterDelete.templates.length).toBe(1);
    expect(afterDelete.allLinks.length).toBe(1);
    db.close();
  });

  it('tracks link usage stats from logs', () => {
    const db = new AutomationDatabase(':memory:');
    const now = Math.floor(Date.now() / 1000);
    db.addLog({
      createdAt: now, chatId: '-1', chatTitle: 'G',
      messageSnippet: 'm', linkUsed: 'https://t.me/x', status: 'SUCCESS',
    });
    db.addLog({
      createdAt: now - 90_000, chatId: '-1', chatTitle: 'G',
      messageSnippet: 'm', linkUsed: 'https://t.me/x', status: 'SUCCESS',
    });
    // Failed sends do not count as usage
    db.addLog({
      createdAt: now, chatId: '-1', chatTitle: 'G',
      messageSnippet: 'm', linkUsed: 'https://t.me/x', status: 'ERROR',
    });

    const stats = db.getLinkUsageStats();
    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({ url: 'https://t.me/x', total: 2, last24h: 1 });
    db.close();
  });

  it('stores resolved campaign link info and member snapshots', () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;
    const link = db.saveCampaignLink({ campaignId, url: 'https://t.me/canal' });

    db.markCampaignLinkResolved(link.id, {
      title: 'Meu Canal', members: 500, type: 'channel', about: 'sobre',
    });
    db.addLinkSnapshot(link.id, 500);
    db.addLinkSnapshot(link.id, 537);

    const campaign = db.getCampaign();
    const record = campaign.allLinks.find((l) => l.id === link.id);
    expect(record?.resolvedTitle).toBe('Meu Canal');
    expect(record?.resolvedMembers).toBe(500);
    expect(record?.resolvedFailed).toBe(false);

    const snapshots = db.getLinkSnapshots(link.id, 2);
    expect(snapshots[0].members).toBe(537);
    expect(snapshots[1].members).toBe(500);

    db.markCampaignLinkResolved(link.id, { failed: true });
    expect(db.getCampaign().allLinks.find((l) => l.id === link.id)?.resolvedFailed).toBe(true);

    db.deleteCampaignLink(link.id);
    expect(db.getLinkSnapshots(link.id)).toEqual([]);
    db.close();
  });

  it('migrates the legacy single-row campaign into templates and links', () => {
    const db = new AutomationDatabase(':memory:');
    // Seed the legacy table directly (pre-migration format)
    db.db.prepare(
      'INSERT INTO campaign (id, spintax_template, links_json, updated_at) VALUES (1, ?, ?, ?)',
    ).run('Oi {bem|tranquilo}?', JSON.stringify(['https://t.me/x', 'https://t.me/y']), 123);
    db.db.prepare('DELETE FROM campaigns').run();

    db.migrateLegacyCampaign();

    const campaign = db.getCampaign();
    expect(campaign.name).toBe('Padrão');
    expect(campaign.templates.length).toBe(1);
    expect(campaign.templates[0].content).toBe('Oi {bem|tranquilo}?');
    expect(campaign.links).toEqual(['https://t.me/x', 'https://t.me/y']);
    db.close();
  });

  it('saves and clears session JSON', () => {
    const db = new AutomationDatabase(':memory:');
    expect(db.getSession()).toBeUndefined();

    db.saveSession('{"dcId":2,"key":"abcd"}');
    expect(db.getSession()).toBe('{"dcId":2,"key":"abcd"}');

    db.clearSession();
    expect(db.getSession()).toBeUndefined();
    db.close();
  });

  it('tracks group states and increments other user messages', () => {
    const db = new AutomationDatabase(':memory:');
    db.upsertGroupState({
      chatId: '-100111',
      title: 'Grupo Divulga A',
      otherMessagesCount: 0,
      slowmodeSeconds: 60,
      starsCost: 0,
      status: 'READY',
    });

    expect(db.getGroupState('-100111')?.otherMessagesCount).toBe(0);

    db.incrementGroupOtherMessages('-100111');
    db.incrementGroupOtherMessages('-100111');
    expect(db.getGroupState('-100111')?.otherMessagesCount).toBe(2);

    db.resetGroupOtherMessages('-100111', 1234567);
    const resetState = db.getGroupState('-100111');
    expect(resetState?.otherMessagesCount).toBe(0);
    expect(resetState?.lastSentAt).toBe(1234567);
    expect(resetState?.status).toBe('SENT');

    db.close();
  });

  it('adds logs and calculates today sent count accurately', () => {
    const db = new AutomationDatabase(':memory:');
    const now = 1_000_000;

    db.addLog({
      createdAt: now - 3600,
      chatId: '-1001',
      chatTitle: 'Grupo 1',
      messageSnippet: 'teste 1',
      linkUsed: 'https://t.me/link1',
      status: 'SUCCESS',
    });

    db.addLog({
      createdAt: now - 1800,
      chatId: '-1002',
      chatTitle: 'Grupo 2',
      messageSnippet: 'teste 2',
      linkUsed: 'https://t.me/link2',
      status: 'SUCCESS',
    });

    db.addLog({
      createdAt: now - 900,
      chatId: '-1003',
      chatTitle: 'Grupo 3',
      messageSnippet: 'teste 3',
      linkUsed: 'https://t.me/link3',
      status: 'FLOOD_WAIT',
    });

    // Old log older than 24h
    db.addLog({
      createdAt: now - 90000,
      chatId: '-1004',
      chatTitle: 'Grupo 4',
      messageSnippet: 'teste 4',
      linkUsed: 'https://t.me/link4',
      status: 'SUCCESS',
    });

    expect(db.getTodaySentCount(now)).toBe(2);
    const recent = db.getRecentLogs(10);
    expect(recent.length).toBe(4);
    expect(recent[0].status).toBe('SUCCESS'); // newest first
    db.close();
  });
});
