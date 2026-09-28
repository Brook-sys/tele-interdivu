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
});
