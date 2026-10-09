import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AutomationScheduler } from '../automation/scheduler';
import { TelegramRunner } from '../automation/telegramRunner';
import { AutomationDatabase } from '../db/database';
import { createApiHandler } from './routes';

describe('Automation REST API routes', () => {
  let server: http.Server;
  let port: number;
  let db: AutomationDatabase;
  let runner: TelegramRunner;
  let scheduler: AutomationScheduler;

  beforeAll(async () => {
    db = new AutomationDatabase(':memory:');
    runner = new TelegramRunner(db);
    scheduler = new AutomationScheduler(db, () => Promise.resolve({ success: true }));

    const handler = createApiHandler(db, runner, scheduler);
    server = http.createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    db.close();
    server.close();
  });

  async function api(path: string, options: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/automation/${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    return {
      status: res.status,
      data: await res.json(),
    };
  }

  it('GET status returns initial stopped state and stats', async () => {
    const { status, data } = await api('status');
    expect(status).toBe(200);
    expect(data.isRunning).toBe(false);
    expect(data.status).toBe('STOPPED');
    expect(data.stats).toBeDefined();
    expect(data.config).toBeDefined();
  });

  it('POST config updates configuration and GET config retrieves it', async () => {
    const postRes = await api('config', {
      method: 'POST',
      body: JSON.stringify({ minDelaySeconds: 45, maxDelaySeconds: 90 }),
    });
    expect(postRes.status).toBe(200);
    expect(postRes.data.minDelaySeconds).toBe(45);
    expect(postRes.data.maxDelaySeconds).toBe(90);

    const getRes = await api('config');
    expect(getRes.status).toBe(200);
    expect(getRes.data.minDelaySeconds).toBe(45);
  });

  it('POST campaign validates and saves spintax and links', async () => {
    const postRes = await api('campaign', {
      method: 'POST',
      body: JSON.stringify({
        spintaxTemplate: '{Oi|Olá} confira: {LINK}',
        links: ['https://t.me/divulga1', 'https://t.me/divulga2'],
      }),
    });
    expect(postRes.status).toBe(200);
    expect(postRes.data.spintaxTemplate).toBe('{Oi|Olá} confira: {LINK}');
    expect(postRes.data.links.length).toBe(2);

    const getRes = await api('campaign');
    expect(getRes.status).toBe(200);
    expect(getRes.data.links[0]).toBe('https://t.me/divulga1');
  });

  it('POST campaign rejects invalid spintax syntax', async () => {
    const postRes = await api('campaign', {
      method: 'POST',
      body: JSON.stringify({
        spintaxTemplate: '{Oi|Olá sem fechar',
        links: [],
      }),
    });
    expect(postRes.status).toBe(400);
    expect(postRes.data.error).toContain('Spintax syntax error');
  });

  it('campaign/links/resolve validates and reports disconnection', async () => {
    const notFound = await api('campaign/links/resolve', {
      method: 'POST',
      body: JSON.stringify({ id: 999999 }),
    });
    expect(notFound.status).toBe(404);

    const tg = await api('campaign/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://t.me/abcxyz' }),
    });
    const external = await api('campaign/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://example.com/a' }),
    });

    const badKind = await api('campaign/links/resolve', {
      method: 'POST',
      body: JSON.stringify({ id: external.data.id }),
    });
    expect(badKind.status).toBe(400);

    const offline = await api('campaign/links/resolve', {
      method: 'POST',
      body: JSON.stringify({ id: tg.data.id }),
    });
    expect(offline.status).toBe(503);
  });

  it('campaign/links/stats returns per-link usage arrays', async () => {
    const res = await api('campaign/links/stats');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
    if (res.data.length) {
      expect(res.data[0]).toHaveProperty('url');
      expect(res.data[0]).toHaveProperty('totalSends');
      expect(res.data[0]).toHaveProperty('last24hSends');
    }
  });

  it('campaign/test-send validates input and requires connection', async () => {
    const empty = await api('campaign/test-send', {
      method: 'POST',
      body: JSON.stringify({ text: '   ' }),
    });
    expect(empty.status).toBe(400);

    const offline = await api('campaign/test-send', {
      method: 'POST',
      body: JSON.stringify({ text: 'mensagem de teste' }),
    });
    expect(offline.status).toBe(503);
  });

  it('manages named campaigns via API', async () => {
    const initial = await api('campaign');
    const initialActiveId = initial.data.id;

    const created = await api('campaign/create', {
      method: 'POST',
      body: JSON.stringify({ name: 'API Campaign' }),
    });
    expect(created.status).toBe(200);
    expect(created.data.id).toBeTruthy();

    const activated = await api('campaign/activate', {
      method: 'POST',
      body: JSON.stringify({ id: created.data.id }),
    });
    expect(activated.status).toBe(200);
    expect(activated.data.campaign.id).toBe(created.data.id);
    expect((await api('campaign')).data.id).toBe(created.data.id);

    const renamed = await api('campaign/rename', {
      method: 'POST',
      body: JSON.stringify({ id: created.data.id, name: 'API Campaign 2' }),
    });
    expect(renamed.status).toBe(200);

    const list = await api('campaigns');
    expect(list.status).toBe(200);
    expect(list.data.some((c: any) => c.name === 'API Campaign 2')).toBe(true);

    const badActivate = await api('campaign/activate', {
      method: 'POST',
      body: JSON.stringify({ id: 987654 }),
    });
    expect(badActivate.status).toBe(404);

    // Restore the original active campaign for the remaining tests
    await api('campaign/activate', {
      method: 'POST',
      body: JSON.stringify({ id: initialActiveId }),
    });
  });

  it('returns performance aggregates', async () => {
    const res = await api('campaign/performance');
    expect(res.status).toBe(200);
    expect(res.data).toHaveProperty('templates');
    expect(res.data).toHaveProperty('hourly');
    expect(res.data).toHaveProperty('topGroups');
    expect(Array.isArray(res.data.hourly)).toBe(true);
    expect(Array.isArray(res.data.links)).toBe(true);
  });

  it('POST test-spintax generates 5 previews', async () => {
    const res = await api('test-spintax', {
      method: 'POST',
      body: JSON.stringify({
        template: '{A|B} - {1|2}',
        links: [],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.data.previews.length).toBe(5);
  });

  it('POST release stops scheduler', async () => {
    const res = await api('release', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('POST skip-pause returns success', async () => {
    const res = await api('skip-pause', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('POST force-new-round returns success', async () => {
    const res = await api('force-new-round', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('GET debug returns system and group telemetry', async () => {
    const res = await api('debug');
    expect(res.status).toBe(200);
    expect(res.data.system).toBeDefined();
    expect(res.data.scheduler).toBeDefined();
    expect(Array.isArray(res.data.groups)).toBe(true);
  });

  it('POST groups/{id} adds a group and GET groups never leaks accessHash', async () => {
    const created = await api(`groups/${encodeURIComponent('-100111222')}`, {
      method: 'POST',
      body: JSON.stringify({ title: 'Remote Group', accessHash: '999888', status: 'READY' }),
    });
    expect(created.status).toBe(200);
    expect(created.data.group.chatId).toBe('-100111222');

    const list = await api('groups');
    const found = list.data.find((g: any) => g.chatId === '-100111222');
    expect(found).toBeDefined();
    expect(found.accessHash).toBeUndefined();
  });

  it('POST groups/{id} without accessHash fails for unknown chats and can quarantine existing ones', async () => {
    const missing = await api(`groups/${encodeURIComponent('-100999000')}`, {
      method: 'POST',
      body: JSON.stringify({ title: 'No Hash' }),
    });
    expect(missing.status).toBe(400);

    const quarantine = await api(`groups/${encodeURIComponent('-100111222')}`, {
      method: 'POST',
      body: JSON.stringify({ status: 'BLOCKED' }),
    });
    expect(quarantine.status).toBe(200);
    expect(quarantine.data.group.status).toBe('BLOCKED');
  });

  it('DELETE groups/{id} removes the group from the rotation', async () => {
    const res = await api(`groups/${encodeURIComponent('-100111222')}`, { method: 'DELETE' });
    expect(res.status).toBe(200);

    const list = await api('groups');
    expect(list.data.find((g: any) => g.chatId === '-100111222')).toBeUndefined();
  });

  it('remote takeover without saved session or targets fails clearly', async () => {
    const res = await api('takeover', { method: 'POST', body: JSON.stringify({}) });
    expect(res.status).toBe(400);
    expect(String(res.data.error)).toContain('saved session');
  });

  it('requires bearer token when AUTOMATION_API_TOKEN is set', async () => {
    process.env.AUTOMATION_API_TOKEN = 'test-token';
    try {
      const denied = await api('status');
      expect(denied.status).toBe(401);

      const allowed = await api('status', {
        headers: { Authorization: 'Bearer test-token' },
      });
      expect(allowed.status).toBe(200);
    } finally {
      delete process.env.AUTOMATION_API_TOKEN;
    }
  });
  it('manages campaign templates via CRUD', async () => {
    const postRes = await api('campaign/templates', {
      method: 'POST',
      body: JSON.stringify({ title: 'A', content: 'Promo {hoje|agora}: {LINK}', weight: 2 }),
    });
    expect(postRes.status).toBe(200);
    expect(postRes.data.weight).toBe(2);
    expect(postRes.data.isEnabled).toBe(true);

    const invalid = await api('campaign/templates', {
      method: 'POST',
      body: JSON.stringify({ title: 'Bad', content: '{Oi|ops' }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.data.error).toContain('Spintax syntax error');

    const toggle = await api('campaign/templates', {
      method: 'POST',
      body: JSON.stringify({
        id: postRes.data.id, title: 'A', content: 'Promo {hoje|agora}: {LINK}', weight: 2, isEnabled: false,
      }),
    });
    expect(toggle.status).toBe(200);
    expect(toggle.data.isEnabled).toBe(false);

    const del = await api(`campaign/templates/${postRes.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);

    const campaign = await api('campaign');
    expect(campaign.data.templates.find((t: any) => t.id === postRes.data.id)).toBeUndefined();
  });

  it('manages campaign links via CRUD', async () => {
    const postRes = await api('campaign/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://t.me/promo-crud' }),
    });
    expect(postRes.status).toBe(200);
    expect(postRes.data.url).toBe('https://t.me/promo-crud');

    const empty = await api('campaign/links', { method: 'POST', body: JSON.stringify({ url: '   ' }) });
    expect(empty.status).toBe(400);

    const toggle = await api('campaign/links', {
      method: 'POST',
      body: JSON.stringify({ id: postRes.data.id, url: 'https://t.me/promo-crud', isEnabled: false }),
    });
    expect(toggle.status).toBe(200);

    const campaign = await api('campaign');
    expect(campaign.data.links).not.toContain('https://t.me/promo-crud');
    expect(campaign.data.allLinks.map((l: any) => l.url)).toContain('https://t.me/promo-crud');

    const del = await api(`campaign/links/${postRes.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
  });

  it('manages campaign destinations via REST (create, assign, focus, delete)', async () => {
    const noName = await api('campaign/destinations', { method: 'POST', body: JSON.stringify({}) });
    expect(noName.status).toBe(400);

    const create = await api('campaign/destinations', {
      method: 'POST',
      body: JSON.stringify({ name: 'Grupo REST', weight: 3 }),
    });
    expect(create.status).toBe(200);
    expect(create.data.name).toBe('Grupo REST');
    expect(create.data.weight).toBe(3);
    expect(create.data.isEnabled).toBe(true);

    const update = await api('campaign/destinations', {
      method: 'POST',
      body: JSON.stringify({ id: create.data.id, isEnabled: false }),
    });
    expect(update.status).toBe(200);
    expect(update.data.name).toBe('Grupo REST');
    expect(update.data.isEnabled).toBe(false);

    const missing = await api('campaign/destinations', {
      method: 'POST',
      body: JSON.stringify({ id: 99999, name: 'x' }),
    });
    expect(missing.status).toBe(404);

    const addLink = await api('campaign/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://t.me/dest-rest', destinationId: create.data.id }),
    });
    expect(addLink.status).toBe(200);
    expect(addLink.data.destinationId).toBe(create.data.id);

    const badDestination = await api('campaign/links', {
      method: 'POST',
      body: JSON.stringify({ url: 'https://t.me/dest-bad', destinationId: 99999 }),
    });
    expect(badDestination.status).toBe(400);

    const focus = await api('campaign/destinations/focus', {
      method: 'POST',
      body: JSON.stringify({ id: create.data.id }),
    });
    expect(focus.status).toBe(200);
    expect(focus.data.campaign.destinations[0].isEnabled).toBe(true);

    const focusMissing = await api('campaign/destinations/focus', {
      method: 'POST',
      body: JSON.stringify({ id: 99999 }),
    });
    expect(focusMissing.status).toBe(404);

    const del = await api(`campaign/destinations/${create.data.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const campaign = await api('campaign');
    expect(campaign.data.destinations).toHaveLength(0);
    // Deleting the destination keeps its links as loose
    expect(campaign.data.allLinks.find((l: any) => l.id === addLink.data.id).destinationId)
      .toBeUndefined();
  });
});

describe('Extractor REST API', () => {
  let exServer: http.Server;
  let exPort: number;
  let exDb: AutomationDatabase;

  beforeAll(async () => {
    exDb = new AutomationDatabase(':memory:');
    const exRunner = new TelegramRunner(exDb);
    const exScheduler = new AutomationScheduler(exDb, () => Promise.resolve({ success: true }));
    const handler = createApiHandler(exDb, exRunner, exScheduler);
    exServer = http.createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      exServer.listen(0, '127.0.0.1', () => {
        exPort = (exServer.address() as any).port;
        resolve();
      });
    });
  });

  afterAll(() => {
    exDb.close();
    exServer.close();
  });

  async function exApi(path: string, options: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${exPort}/api/v1/automation/${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    return { status: res.status, data: await res.json() };
  }

  it('extract endpoints list, export and clear extracted items', async () => {
    // Seed via DB directly (extraction itself is covered in links.test.ts)
    exDb.upsertExtractedItem({
      kind: 'invite_link',
      value: 't.me/+TestSeed',
      domain: 't.me',
      sourceChatId: '-1001',
      sourceChatTitle: 'Grupo Teste',
    });
    exDb.upsertExtractedItem({
      kind: 'external_link',
      value: 'example.com/oferta',
      domain: 'example.com',
      sourceChatId: '-1001',
      sourceChatTitle: 'Grupo Teste',
    });
    // Same link again: must dedup into times_seen++
    exDb.upsertExtractedItem({
      kind: 'invite_link',
      value: 't.me/+TestSeed',
      domain: 't.me',
      sourceChatId: '-1002',
      sourceChatTitle: 'Outro Grupo',
    });

    const list = await exApi('extract/links');
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(2);
    const invite = list.data.find((i: any) => i.value === 't.me/+TestSeed');
    expect(invite.timesSeen).toBe(2);

    const filtered = await exApi('extract/links?kind=invite_link');
    expect(filtered.data).toHaveLength(1);

    const stats = await exApi('extract/stats');
    expect(stats.status).toBe(200);
    expect(stats.data.enabled).toBe(true);
    expect(stats.data.byKind.find((k: any) => k.kind === 'invite_link').total).toBe(1);

    const text = await fetch(`http://127.0.0.1:${exPort}/api/v1/automation/extract/export?kind=invite_link`);
    expect(text.status).toBe(200);
    expect((await text.text()).trim()).toBe('t.me/+TestSeed');

    const cleared = await exApi('extract/clear', { method: 'POST', body: JSON.stringify({ kind: 'invite_link' }) });
    expect(cleared.status).toBe(200);
    const after = await exApi('extract/links');
    expect(after.data).toHaveLength(1);
    expect(after.data[0].kind).toBe('external_link');
  });

  it('exports every extracted item even beyond the interactive list cap', async () => {
    const EXPORT_SEED_COUNT = 550;

    // Drop leftovers from the previous case so the counts below are exact
    exDb.clearExtractedItems('external_link');

    for (let i = 0; i < EXPORT_SEED_COUNT; i++) {
      exDb.upsertExtractedItem({
        kind: 'external_link',
        value: `example.com/bulk-${i}`,
        domain: 'example.com',
        sourceChatId: '-1007',
        sourceChatTitle: 'Grupo Bulk',
      });
    }

    // The interactive list stays a bounded window
    const list = await exApi(`extract/links?kind=external_link&limit=100000`);
    expect(list.status).toBe(200);
    expect(list.data).toHaveLength(500);

    // The TXT export delivers the full harvest, no silent truncation
    const text = await fetch(`http://127.0.0.1:${exPort}/api/v1/automation/extract/export?kind=external_link`);
    expect(text.status).toBe(200);
    const textLines = (await text.text()).trim().split('\n');
    expect(textLines).toHaveLength(EXPORT_SEED_COUNT);
    expect(new Set(textLines).size).toBe(EXPORT_SEED_COUNT);

    // Same for CSV: header + one row per item
    const csv = await fetch(
      `http://127.0.0.1:${exPort}/api/v1/automation/extract/export?kind=external_link&format=csv`,
    );
    expect(csv.status).toBe(200);
    const csvLines = (await csv.text()).trim().split('\n');
    expect(csvLines).toHaveLength(EXPORT_SEED_COUNT + 1);

    exDb.clearExtractedItems('external_link');
  });
});

describe('Extractor resolve & CSV export', () => {
  let ctx2: { db: AutomationDatabase; server: http.Server; port: number };

  beforeAll(async () => {
    const db = new AutomationDatabase(':memory:');
    const runner = new TelegramRunner(db);
    const scheduler = new AutomationScheduler(db, () => Promise.resolve({ success: true }));
    const handler = createApiHandler(db, runner, scheduler);
    const server = http.createServer(async (req, res) => {
      const handled = await handler(req, res);
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    ctx2 = { db, server, port: (server.address() as any).port };
  });

  afterAll(() => {
    ctx2.db.close();
    ctx2.server.close();
  });

  async function api2(path: string, options: RequestInit = {}) {
    const res = await fetch(`http://127.0.0.1:${ctx2.port}/api/v1/automation/${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, text, headers: res.headers };
  }

  it('resolve validates input and reports disconnected daemon', async () => {
    expect((await api2('extract/resolve', { method: 'POST', body: '{}' })).status).toBe(400);

    const badLink = await api2('extract/resolve', {
      method: 'POST', body: JSON.stringify({ kind: 'invite_link', value: 'example.com/x' }),
    });
    expect(badLink.status).toBe(400);

    const offline = await api2('extract/resolve', {
      method: 'POST', body: JSON.stringify({ kind: 'invite_link', value: 't.me/+ValidHash123' }),
    });
    expect(offline.status).toBe(503);
  });

  it('CSV export escapes quotes/commas and uses ISO dates + BOM', async () => {
    ctx2.db.upsertExtractedItem({
      kind: 'invite_link',
      value: 't.me/+CsvTest',
      domain: 't.me',
      sourceChatId: '-1001',
      sourceChatTitle: 'Grupo "Com, virgula"',
    });
    ctx2.db.markExtractedResolved('invite_link', 't.me/+CsvTest', {
      title: 'Destino "X"',
      members: 1500,
      type: 'group',
      about: 'sobre, com virgula',
    });

    const res = await api2('extract/export?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const bytes = Buffer.from(await (await fetch(
      `http://127.0.0.1:${ctx2.port}/api/v1/automation/extract/export?format=csv`,
    )).arrayBuffer());
    // UTF-8 BOM so Excel opens the CSV with proper encoding
    expect(bytes[0]).toBe(0xef);
    expect(bytes[1]).toBe(0xbb);
    expect(bytes[2]).toBe(0xbf);
    expect(res.text).toContain('kind,value,resolved_title');
    expect(res.text).toContain('"Grupo ""Com, virgula"""');
    expect(res.text).toContain('"Destino ""X"""');
    expect(res.text).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
