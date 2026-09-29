// node:sqlite requires literal null to bind SQL NULL values
/* eslint-disable no-null/no-null */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface AutomationDbConfig {
  mode: 'manual' | 'continuous';
  minDelaySeconds: number;
  maxDelaySeconds: number;
  roundIntervalMinutes: number;
  roundTargetSends: number;
  minOtherMessages: number;
  sleepWindowEnabled: boolean;
  sleepWindowStart: string;
  sleepWindowEnd: string;
  dailyLimit: number;
  linkPreviewEnabled: boolean;
  microPauseEnabled: boolean;
  microPauseEveryMin: number;
  microPauseEveryMax: number;
  microPauseSeconds: number;
}

export interface AutomationCampaign {
  spintaxTemplate: string;
  links: string[];
  updatedAt: number;
}

export interface GroupStateRecord {
  chatId: string;
  title: string;
  lastSentAt?: number;
  otherMessagesCount: number;
  slowmodeSeconds: number;
  slowmodeNextSendDate?: number;
  starsCost: number;
  status: 'READY' | 'WAITING_SLOWMODE' | 'WAITING_MESSAGES' | 'BLOCKED' | 'STARS' | 'SENT';
  lastError?: string;
  updatedAt: number;
}

export interface AutomationLogRecord {
  id?: number;
  createdAt: number;
  chatId: string;
  chatTitle: string;
  messageSnippet: string;
  linkUsed: string;
  status: 'SUCCESS' | 'FLOOD_WAIT' | 'ERROR' | 'SKIPPED';
  details?: string;
}

export const DEFAULT_CONFIG: AutomationDbConfig = {
  mode: 'manual',
  minDelaySeconds: 60,
  maxDelaySeconds: 180,
  roundIntervalMinutes: 120,
  roundTargetSends: 23,
  minOtherMessages: 5,
  sleepWindowEnabled: true,
  sleepWindowStart: '23:30',
  sleepWindowEnd: '07:30',
  dailyLimit: 80,
  linkPreviewEnabled: false,
  microPauseEnabled: true,
  microPauseEveryMin: 6,
  microPauseEveryMax: 10,
  microPauseSeconds: 300,
};

export class AutomationDatabase {
  public readonly db: DatabaseSync;

  constructor(customPath?: string) {
    let dbPath = customPath;
    if (!dbPath) {
      if (fs.existsSync('/data') && fs.statSync('/data').isDirectory()) {
        dbPath = '/data/automation.db';
      } else {
        const localDataDir = path.resolve(process.cwd(), 'data');
        if (!fs.existsSync(localDataDir)) {
          fs.mkdirSync(localDataDir, { recursive: true });
        }
        dbPath = path.join(localDataDir, 'automation.db');
      }
    }

    this.db = new DatabaseSync(dbPath);
    this.initTables();
  }

  private initTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        mode TEXT NOT NULL,
        min_delay_seconds INTEGER NOT NULL,
        max_delay_seconds INTEGER NOT NULL,
        round_interval_minutes INTEGER NOT NULL,
        round_target_sends INTEGER NOT NULL DEFAULT 23,
        min_other_messages INTEGER NOT NULL,
        sleep_window_enabled INTEGER NOT NULL,
        sleep_window_start TEXT NOT NULL,
        sleep_window_end TEXT NOT NULL,
        daily_limit INTEGER NOT NULL,
        link_preview_enabled INTEGER NOT NULL,
        micro_pause_enabled INTEGER NOT NULL DEFAULT 1,
        micro_pause_every_min INTEGER NOT NULL DEFAULT 6,
        micro_pause_every_max INTEGER NOT NULL DEFAULT 10,
        micro_pause_seconds INTEGER NOT NULL DEFAULT 300
      );

      CREATE TABLE IF NOT EXISTS campaign (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        spintax_template TEXT NOT NULL,
        links_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        session_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_state (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        last_sent_at INTEGER,
        other_messages_count INTEGER NOT NULL DEFAULT 0,
        slowmode_seconds INTEGER NOT NULL DEFAULT 0,
        slowmode_next_send_date INTEGER,
        stars_cost INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'READY',
        last_error TEXT,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        message_snippet TEXT NOT NULL,
        link_used TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);
    `);

    // Migrations for existing databases: ensure new columns exist
    try {
      this.db.exec('ALTER TABLE group_state ADD COLUMN stars_cost INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN micro_pause_enabled INTEGER NOT NULL DEFAULT 1');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN micro_pause_every_min INTEGER NOT NULL DEFAULT 6');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN micro_pause_every_max INTEGER NOT NULL DEFAULT 10');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN micro_pause_seconds INTEGER NOT NULL DEFAULT 300');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN round_target_sends INTEGER NOT NULL DEFAULT 23');
    } catch {
      // Column already exists
    }

    // Auto-quarantine any groups that previously failed with ALLOW_PAYMENT_REQUIRED
    try {
      this.db.exec(`
        UPDATE group_state
        SET status = 'STARS', stars_cost = 20
        WHERE last_error LIKE '%ALLOW_PAYMENT_REQUIRED%'
           OR last_error LIKE '%PAYMENT_REQUIRED%'
      `);
    } catch {
      // ignore
    }

    // Ensure initial config row exists
    const row = this.db.prepare('SELECT id FROM config WHERE id = 1').get();
    if (!row) {
      this.db.prepare(`
        INSERT INTO config (
          id, mode, min_delay_seconds, max_delay_seconds, round_interval_minutes,
          round_target_sends, min_other_messages, sleep_window_enabled, sleep_window_start,
          sleep_window_end, daily_limit, link_preview_enabled, micro_pause_enabled,
          micro_pause_every_min, micro_pause_every_max, micro_pause_seconds
        ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        DEFAULT_CONFIG.mode,
        DEFAULT_CONFIG.minDelaySeconds,
        DEFAULT_CONFIG.maxDelaySeconds,
        DEFAULT_CONFIG.roundIntervalMinutes,
        DEFAULT_CONFIG.roundTargetSends,
        DEFAULT_CONFIG.minOtherMessages,
        DEFAULT_CONFIG.sleepWindowEnabled ? 1 : 0,
        DEFAULT_CONFIG.sleepWindowStart,
        DEFAULT_CONFIG.sleepWindowEnd,
        DEFAULT_CONFIG.dailyLimit,
        DEFAULT_CONFIG.linkPreviewEnabled ? 1 : 0,
        DEFAULT_CONFIG.microPauseEnabled ? 1 : 0,
        DEFAULT_CONFIG.microPauseEveryMin,
        DEFAULT_CONFIG.microPauseEveryMax,
        DEFAULT_CONFIG.microPauseSeconds,
      );
    }
  }

  getConfig(): AutomationDbConfig {
    const row = this.db.prepare('SELECT * FROM config WHERE id = 1').get() as any;
    if (!row) return DEFAULT_CONFIG;

    return {
      mode: row.mode,
      minDelaySeconds: Number(row.min_delay_seconds),
      maxDelaySeconds: Number(row.max_delay_seconds),
      roundIntervalMinutes: Number(row.round_interval_minutes),
      roundTargetSends: Number(row.round_target_sends ?? DEFAULT_CONFIG.roundTargetSends),
      minOtherMessages: Number(row.min_other_messages),
      sleepWindowEnabled: Boolean(row.sleep_window_enabled),
      sleepWindowStart: String(row.sleep_window_start),
      sleepWindowEnd: String(row.sleep_window_end),
      dailyLimit: Number(row.daily_limit),
      linkPreviewEnabled: Boolean(row.link_preview_enabled),
      microPauseEnabled: row.micro_pause_enabled !== undefined
        ? Boolean(row.micro_pause_enabled) : DEFAULT_CONFIG.microPauseEnabled,
      microPauseEveryMin: Number(row.micro_pause_every_min ?? DEFAULT_CONFIG.microPauseEveryMin),
      microPauseEveryMax: Number(row.micro_pause_every_max ?? DEFAULT_CONFIG.microPauseEveryMax),
      microPauseSeconds: Number(row.micro_pause_seconds ?? DEFAULT_CONFIG.microPauseSeconds),
    };
  }

  updateConfig(patch: Partial<AutomationDbConfig>): AutomationDbConfig {
    const current = this.getConfig();
    const next = { ...current, ...patch };

    this.db.prepare(`
      UPDATE config SET
        mode = ?,
        min_delay_seconds = ?,
        max_delay_seconds = ?,
        round_interval_minutes = ?,
        round_target_sends = ?,
        min_other_messages = ?,
        sleep_window_enabled = ?,
        sleep_window_start = ?,
        sleep_window_end = ?,
        daily_limit = ?,
        link_preview_enabled = ?,
        micro_pause_enabled = ?,
        micro_pause_every_min = ?,
        micro_pause_every_max = ?,
        micro_pause_seconds = ?
      WHERE id = 1
    `).run(
      next.mode,
      next.minDelaySeconds,
      next.maxDelaySeconds,
      next.roundIntervalMinutes,
      next.roundTargetSends,
      next.minOtherMessages,
      next.sleepWindowEnabled ? 1 : 0,
      next.sleepWindowStart,
      next.sleepWindowEnd,
      next.dailyLimit,
      next.linkPreviewEnabled ? 1 : 0,
      next.microPauseEnabled ? 1 : 0,
      next.microPauseEveryMin,
      next.microPauseEveryMax,
      next.microPauseSeconds,
    );

    return next;
  }

  getCampaign(): AutomationCampaign {
    const row = this.db.prepare('SELECT * FROM campaign WHERE id = 1').get() as any;
    if (!row) {
      return {
        spintaxTemplate: '',
        links: [],
        updatedAt: 0,
      };
    }

    let links: string[];
    try {
      const parsed = JSON.parse(row.links_json);
      links = Array.isArray(parsed) ? parsed : [];
    } catch {
      links = [];
    }

    return {
      spintaxTemplate: String(row.spintax_template),
      links,
      updatedAt: Number(row.updated_at),
    };
  }

  saveCampaign(spintaxTemplate: string, links: string[]): AutomationCampaign {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO campaign (id, spintax_template, links_json, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        spintax_template = excluded.spintax_template,
        links_json = excluded.links_json,
        updated_at = excluded.updated_at
    `).run(spintaxTemplate, JSON.stringify(links), now);

    return {
      spintaxTemplate,
      links,
      updatedAt: now,
    };
  }

  getSession(): string | undefined {
    const row = this.db.prepare('SELECT session_json FROM session WHERE id = 1').get() as any;
    return row ? String(row.session_json) : undefined;
  }

  saveSession(sessionJson: string) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO session (id, session_json, updated_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        session_json = excluded.session_json,
        updated_at = excluded.updated_at
    `).run(sessionJson, now);
  }

  clearSession() {
    this.db.prepare('DELETE FROM session WHERE id = 1').run();
  }

  upsertGroupState(record: Omit<GroupStateRecord, 'updatedAt'>) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO group_state (
        chat_id, title, last_sent_at, other_messages_count, slowmode_seconds,
        slowmode_next_send_date, stars_cost, status, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        title = excluded.title,
        last_sent_at = coalesce(excluded.last_sent_at, group_state.last_sent_at),
        other_messages_count = excluded.other_messages_count,
        slowmode_seconds = excluded.slowmode_seconds,
        slowmode_next_send_date = excluded.slowmode_next_send_date,
        stars_cost = excluded.stars_cost,
        status = excluded.status,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(
      record.chatId,
      record.title,
      record.lastSentAt ?? null,
      record.otherMessagesCount,
      record.slowmodeSeconds,
      record.slowmodeNextSendDate ?? null,
      record.starsCost || 0,
      record.status,
      record.lastError ?? null,
      now,
    );
  }

  setGroupStarsCost(chatId: string, starsCost: number) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE group_state SET
        stars_cost = ?,
        status = 'STARS',
        last_error = ?,
        updated_at = ?
      WHERE chat_id = ?
    `).run(starsCost, `Exige pagamento de ${starsCost} estrelas`, now, chatId);
  }

  syncTargetGroups(validChatIds: string[]) {
    if (!validChatIds.length) return;
    const placeholders = validChatIds.map(() => '?').join(',');
    this.db.prepare(`
      DELETE FROM group_state WHERE chat_id NOT IN (${placeholders})
    `).run(...validChatIds);
  }

  incrementGroupOtherMessages(chatId: string) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE group_state SET
        other_messages_count = other_messages_count + 1,
        updated_at = ?
      WHERE chat_id = ?
    `).run(now, chatId);
  }

  setGroupOtherMessagesCount(chatId: string, count: number) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE group_state SET
        other_messages_count = ?,
        updated_at = ?
      WHERE chat_id = ?
    `).run(count, now, chatId);
  }

  setGroupSlowmode(chatId: string, slowmodeSeconds: number, slowmodeNextSendDate?: number) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE group_state SET
        slowmode_seconds = ?,
        slowmode_next_send_date = ?,
        status = 'WAITING_SLOWMODE',
        updated_at = ?
      WHERE chat_id = ?
    `).run(slowmodeSeconds, slowmodeNextSendDate ?? null, now, chatId);
  }

  resetGroupOtherMessages(chatId: string, lastSentAt: number) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE group_state SET
        other_messages_count = 0,
        last_sent_at = ?,
        status = 'SENT',
        updated_at = ?
      WHERE chat_id = ?
    `).run(lastSentAt, now, chatId);
  }

  getAllGroupStates(): GroupStateRecord[] {
    const rows = this.db.prepare('SELECT * FROM group_state ORDER BY title COLLATE NOCASE').all() as any[];
    return rows.map((row) => ({
      chatId: String(row.chat_id),
      title: String(row.title),
      lastSentAt: row.last_sent_at ? Number(row.last_sent_at) : undefined,
      otherMessagesCount: Number(row.other_messages_count),
      slowmodeSeconds: Number(row.slowmode_seconds),
      slowmodeNextSendDate: row.slowmode_next_send_date ? Number(row.slowmode_next_send_date) : undefined,
      starsCost: Number(row.stars_cost || 0),
      status: row.status,
      lastError: row.last_error ? String(row.last_error) : undefined,
      updatedAt: Number(row.updated_at),
    }));
  }

  getGroupState(chatId: string): GroupStateRecord | undefined {
    const row = this.db.prepare('SELECT * FROM group_state WHERE chat_id = ?').get(chatId) as any;
    if (!row) return undefined;
    return {
      chatId: String(row.chat_id),
      title: String(row.title),
      lastSentAt: row.last_sent_at ? Number(row.last_sent_at) : undefined,
      otherMessagesCount: Number(row.other_messages_count),
      slowmodeSeconds: Number(row.slowmode_seconds),
      slowmodeNextSendDate: row.slowmode_next_send_date ? Number(row.slowmode_next_send_date) : undefined,
      starsCost: Number(row.stars_cost || 0),
      status: row.status,
      lastError: row.last_error ? String(row.last_error) : undefined,
      updatedAt: Number(row.updated_at),
    };
  }

  addLog(log: AutomationLogRecord) {
    this.db.prepare(`
      INSERT INTO logs (created_at, chat_id, chat_title, message_snippet, link_used, status, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.createdAt,
      log.chatId,
      log.chatTitle,
      log.messageSnippet,
      log.linkUsed,
      log.status,
      log.details ?? null,
    );
  }

  getRecentLogs(limit = 50): AutomationLogRecord[] {
    const rows = this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit) as any[];
    return rows.map((row) => ({
      id: Number(row.id),
      createdAt: Number(row.created_at),
      chatId: String(row.chat_id),
      chatTitle: String(row.chat_title),
      messageSnippet: String(row.message_snippet),
      linkUsed: String(row.link_used),
      status: row.status,
      details: row.details ? String(row.details) : undefined,
    }));
  }

  getTodaySentCount(serverNow: number): number {
    // 24 hours window
    const since = serverNow - 86400;
    const row = this.db.prepare(`
      SELECT count(*) as count FROM logs
      WHERE created_at >= ? AND status = 'SUCCESS'
    `).get(since) as any;
    return row ? Number(row.count) : 0;
  }

  close() {
    this.db.close();
  }
}
