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

  it('manages named campaigns with duplicate, activate and rename', () => {
    const db = new AutomationDatabase(':memory:');
    const first = db.getCampaign();
    db.saveCampaignTemplate({ campaignId: first.id, title: 'A', content: 'T1 {LINK}' });
    db.saveCampaignLink({ campaignId: first.id, url: 'https://t.me/x' });

    const copyId = db.duplicateCampaign(first.id, 'Cópia');
    db.activateCampaign(copyId);
    const active = db.getCampaign();
    expect(active.id).toBe(copyId);
    expect(active.name).toBe('Cópia');
    expect(active.templates).toHaveLength(1);
    expect(active.templates[0].content).toBe('T1 {LINK}');
    expect(active.links).toEqual(['https://t.me/x']);

    db.activateCampaign(first.id);
    const back = db.getCampaign();
    expect(back.id).toBe(first.id);
    expect(back.templates[0].content).toBe('T1 {LINK}');

    db.renameCampaign(first.id, 'Renomeada');
    expect(db.getCampaigns().find((c) => c.id === first.id)?.name).toBe('Renomeada');
    db.close();
  });

  it('computes performance aggregates from logs', () => {
    const db = new AutomationDatabase(':memory:');
    const now = Math.floor(Date.now() / 1000);
    const campaignId = db.getCampaign().id;
    const template = db.saveCampaignTemplate({ campaignId, content: 'x' });

    db.addLog({
      createdAt: now, templateId: template.id, chatId: '-1', chatTitle: 'G1',
      messageSnippet: 'm', linkUsed: 'l', status: 'SUCCESS',
    });
    db.addLog({
      createdAt: now, templateId: template.id, chatId: '-1', chatTitle: 'G1',
      messageSnippet: 'm', linkUsed: 'l', status: 'ERROR',
    });
    db.addLog({
      createdAt: now, templateId: template.id, chatId: 'system', chatTitle: 'Sistema',
      messageSnippet: 'm', linkUsed: '', status: 'ERROR',
    });

    const templateStats = db.getTemplateStats(0);
    expect(templateStats).toHaveLength(2);

    const chatStats = db.getChatStats(0);
    expect(chatStats[0]).toMatchObject({ chatId: '-1', attempts: 2, successes: 1 });

    const hourly = db.getHourlySuccess(0);
    expect(hourly).toHaveLength(1);
    expect(hourly[0].count).toBe(1);
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

  it('manages destinations with weights, toggles and link assignment', () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;

    const destination = db.saveDestination({ campaignId, name: 'Grupo X' });
    expect(destination.name).toBe('Grupo X');
    expect(destination.weight).toBe(1);
    expect(destination.isEnabled).toBe(true);

    const updated = db.saveDestination({ campaignId, id: destination.id, weight: 5 });
    // Name is preserved when the patch omits it
    expect(updated.name).toBe('Grupo X');
    expect(updated.weight).toBe(5);

    const assigned = db.saveCampaignLink({
      campaignId, url: 'https://t.me/x1', destinationId: destination.id,
    });
    expect(assigned.destinationId).toBe(destination.id);

    // Plain link toggles preserve the assignment
    db.saveCampaignLink({
      campaignId, id: assigned.id, url: 'https://t.me/x1', isEnabled: false,
    });
    expect(db.getCampaign().allLinks[0].destinationId).toBe(destination.id);

    const campaign = db.getCampaign();
    expect(campaign.destinations).toHaveLength(1);

    db.deleteCampaignDestination(destination.id);
    const afterDelete = db.getCampaign();
    expect(afterDelete.destinations).toHaveLength(0);
    // Deleting the destination keeps its links as loose
    expect(afterDelete.allLinks[0].destinationId).toBeUndefined();
    db.close();
  });

  it('focuses a destination, enabling only it', () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;
    const a = db.saveDestination({ campaignId, name: 'A' });
    const b = db.saveDestination({ campaignId, name: 'B' });
    const c = db.saveDestination({ campaignId, name: 'C', isEnabled: false });

    expect(db.focusDestination(b.id)).toBe(true);
    const focused = db.getCampaign().destinations;
    expect(focused.find((d) => d.id === a.id)?.isEnabled).toBe(false);
    expect(focused.find((d) => d.id === b.id)?.isEnabled).toBe(true);
    expect(focused.find((d) => d.id === c.id)?.isEnabled).toBe(false);

    expect(db.focusDestination(999)).toBe(false);
    db.close();
  });

  it('migrates unassigned links into destinations grouped by resolved title', () => {
    const db = new AutomationDatabase(':memory:');
    // Campaigns created after construction keep the pending-migration flag,
    // matching pre-feature campaigns (the ALTER seeds them with 0)
    const campaignId = db.createCampaign('Migração');
    db.activateCampaign(campaignId);

    const fooA = db.saveCampaignLink({ campaignId, url: 'https://t.me/fooA' });
    const fooB = db.saveCampaignLink({ campaignId, url: 'https://t.me/fooB' });
    const bar = db.saveCampaignLink({ campaignId, url: 'https://t.me/bar' });
    db.markCampaignLinkResolved(fooA.id, { title: 'Foo Group' });
    db.markCampaignLinkResolved(fooB.id, { title: 'Foo Group' });
    db.markCampaignLinkResolved(bar.id, { title: 'Bar Group' });
    const untitled = db.saveCampaignLink({ campaignId, url: 'https://t.me/plain' });

    db.migrateDestinations();

    const campaign = db.getCampaign();
    expect(campaign.destinations.map((d) => d.name)).toEqual([
      'Foo Group', 'Bar Group', 'Destino inicial',
    ]);

    const fooLinks = campaign.allLinks.filter((l) => l.destinationId === campaign.destinations[0].id);
    expect(fooLinks.map((l) => l.url).sort()).toEqual(['https://t.me/fooA', 'https://t.me/fooB']);
    expect(
      campaign.allLinks.find((l) => l.id === untitled.id)?.destinationId,
    ).toBe(campaign.destinations[2].id);

    // One-time only: a second run never re-groups links added later
    const later = db.saveCampaignLink({ campaignId, url: 'https://t.me/later' });
    db.migrateDestinations();
    expect(db.getCampaign().allLinks.find((l) => l.id === later.id)?.destinationId).toBeUndefined();
    db.close();
  });

  it('duplicates a campaign with its destinations and link mapping', () => {
    const db = new AutomationDatabase(':memory:');
    const sourceId = db.getCampaign().id;
    const destination = db.saveDestination({ campaignId: sourceId, name: 'Grupo X', weight: 4 });
    db.saveCampaignLink({ campaignId: sourceId, url: 'https://t.me/x', destinationId: destination.id });
    db.saveCampaignLink({ campaignId: sourceId, url: 'https://t.me/loose' });

    const copyId = db.duplicateCampaign(sourceId, 'Cópia');
    db.activateCampaign(copyId);
    const active = db.getCampaign();
    expect(active.destinations).toHaveLength(1);
    expect(active.destinations[0].name).toBe('Grupo X');
    expect(active.destinations[0].weight).toBe(4);

    const copyAssigned = active.allLinks.find((l) => l.url === 'https://t.me/x');
    // The copy's link points at the copy's own destination id
    expect(copyAssigned?.destinationId).toBe(active.destinations[0].id);
    expect(active.allLinks.find((l) => l.url === 'https://t.me/loose')?.destinationId).toBeUndefined();
    db.close();
  });

  it('replaces campaign content mapping destinationIndex to local ids', () => {
    const db = new AutomationDatabase(':memory:');
    const campaignId = db.getCampaign().id;

    db.replaceCampaignContent(
      campaignId,
      [{ title: 'T', content: 'oi {LINK}', weight: 2, isEnabled: true }],
      [
        { url: 'https://t.me/a', isEnabled: true, destinationIndex: 1 },
        { url: 'https://t.me/b', isEnabled: true },
        { url: 'https://t.me/c', isEnabled: false, destinationIndex: 0 },
      ],
      [
        { name: 'Primeiro', weight: 3, isEnabled: true },
        { name: 'Segundo', isEnabled: false },
      ],
    );

    const campaign = db.getCampaign();
    expect(campaign.destinations.map((d) => d.name)).toEqual(['Primeiro', 'Segundo']);
    expect(campaign.destinations[0].weight).toBe(3);
    expect(campaign.destinations[1].isEnabled).toBe(false);

    expect(campaign.allLinks.find((l) => l.url === 'https://t.me/a')?.destinationId)
      .toBe(campaign.destinations[1].id);
    expect(campaign.allLinks.find((l) => l.url === 'https://t.me/b')?.destinationId).toBeUndefined();
    expect(campaign.allLinks.find((l) => l.url === 'https://t.me/c')?.destinationId)
      .toBe(campaign.destinations[0].id);
    db.close();
  });

  it('stores destination attribution in send logs', () => {
    const db = new AutomationDatabase(':memory:');
    const now = Math.floor(Date.now() / 1000);
    db.addLog({
      createdAt: now,
      templateId: 1,
      destinationId: 7,
      chatId: '-100',
      chatTitle: 'G',
      messageSnippet: 'm',
      linkUsed: 'https://t.me/x',
      status: 'SUCCESS',
    });

    const recent = db.getRecentLogs(5);
    expect(recent[0].destinationId).toBe(7);
    expect(recent[0].templateId).toBe(1);
    db.close();
  });
});
