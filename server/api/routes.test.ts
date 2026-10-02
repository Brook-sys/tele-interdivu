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
});
