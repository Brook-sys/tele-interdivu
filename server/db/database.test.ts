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
