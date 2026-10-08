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
  minResendIntervalMinutes: number;
  sleepWindowEnabled: boolean;
  sleepWindowStart: string;
  sleepWindowEnd: string;
  dailyLimit: number;
  linkPreviewEnabled: boolean;
  microPauseEnabled: boolean;
  microPauseEveryMin: number;
  microPauseEveryMax: number;
  microPauseSeconds: number;
  extractorEnabled: boolean;
  templateRotationEnabled: boolean;
  memberTrackingEnabled: boolean;
  memberTrackingIntervalHours: number;
}

// Fields the orchestration master may define globally: a defined override
// replaces the local value at read time (effective config), while the local
// config table is never touched. Extending this map is protocol-compatible —
// old workers simply ignore fields they do not know.
export const OVERRIDEABLE_CONFIG_FIELDS: Partial<Record<keyof AutomationDbConfig, 'string' | 'number' | 'boolean'>> = {
  mode: 'string',
  minDelaySeconds: 'number',
  maxDelaySeconds: 'number',
  roundIntervalMinutes: 'number',
  roundTargetSends: 'number',
  minOtherMessages: 'number',
  minResendIntervalMinutes: 'number',
  sleepWindowEnabled: 'boolean',
  sleepWindowStart: 'string',
  sleepWindowEnd: 'string',
  dailyLimit: 'number',
  linkPreviewEnabled: 'boolean',
  microPauseEnabled: 'boolean',
  microPauseEveryMin: 'number',
  microPauseEveryMax: 'number',
  microPauseSeconds: 'number',
  extractorEnabled: 'boolean',
  templateRotationEnabled: 'boolean',
};

export interface CampaignTemplateRecord {
  id: number;
  title: string;
  content: string;
  weight: number;
  isEnabled: boolean;
  position: number;
  updatedAt: number;
}

export interface CampaignDestinationRecord {
  id: number;
  name: string;
  weight: number;
  isEnabled: boolean;
  position: number;
  updatedAt: number;
}

export interface CampaignLinkRecord {
  id: number;
  url: string;
  isEnabled: boolean;
  position: number;
  updatedAt: number;
  // Owning destination; undefined means a loose link (no destination)
  destinationId?: number;
  resolvedTitle?: string;
  resolvedMembers?: number;
  resolvedType?: string;
  resolvedAbout?: string;
  resolvedPhotoB64?: string;
  resolvedAt?: number;
  // True when the destination was checked and is invalid/expired
  resolvedFailed?: boolean;
}

export interface AutomationCampaign {
  id: number;
  name: string;
  // Content of the first enabled template (convenience/compat field)
  spintaxTemplate: string;
  templates: CampaignTemplateRecord[];
  // Promotion destinations; each send picks one enabled destination by weight
  destinations: CampaignDestinationRecord[];
  // Enabled link urls (convenience/compat field)
  links: string[];
  allLinks: CampaignLinkRecord[];
  updatedAt: number;
}

export interface GroupStateRecord {
  chatId: string;
  title: string;
  accessHash?: string;
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
  templateId?: number;
  // Destination whose link was promoted in this send (attribution snapshot)
  destinationId?: number;
  chatId: string;
  chatTitle: string;
  messageSnippet: string;
  linkUsed: string;
  status: 'SUCCESS' | 'FLOOD_WAIT' | 'ERROR' | 'SKIPPED';
  details?: string;
}

export interface ExtractedItemRecord {
  kind: string;
  value: string;
  domain?: string;
  preview?: string;
  sourceChatId: string;
  sourceChatTitle: string;
  messageId?: number;
  senderId?: string;
  firstSeenAt: number;
  lastSeenAt: number;
  timesSeen: number;
  resolvedTitle?: string;
  resolvedMembers?: number;
  resolvedType?: string;
  resolvedPhotoB64?: string;
  resolvedAbout?: string;
  resolvedAt?: number;
  // True when the invite was checked and is invalid/expired
  resolvedFailed?: boolean;
}

export const DEFAULT_CONFIG: AutomationDbConfig = {
  mode: 'manual',
  minDelaySeconds: 60,
  maxDelaySeconds: 180,
  roundIntervalMinutes: 120,
  roundTargetSends: 23,
  minOtherMessages: 5,
  minResendIntervalMinutes: 10,
  sleepWindowEnabled: true,
  sleepWindowStart: '23:30',
  sleepWindowEnd: '07:30',
  dailyLimit: 80,
  linkPreviewEnabled: false,
  microPauseEnabled: true,
  microPauseEveryMin: 6,
  microPauseEveryMax: 10,
  microPauseSeconds: 300,
  extractorEnabled: true,
  templateRotationEnabled: false,
  // Opt-in and OFF by default: periodic reads are still account activity
  memberTrackingEnabled: false,
  memberTrackingIntervalHours: 6,
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
        min_resend_interval_minutes INTEGER NOT NULL DEFAULT 10,
        sleep_window_enabled INTEGER NOT NULL,
        sleep_window_start TEXT NOT NULL,
        sleep_window_end TEXT NOT NULL,
        daily_limit INTEGER NOT NULL,
        link_preview_enabled INTEGER NOT NULL,
        micro_pause_enabled INTEGER NOT NULL DEFAULT 1,
        micro_pause_every_min INTEGER NOT NULL DEFAULT 6,
        micro_pause_every_max INTEGER NOT NULL DEFAULT 10,
        micro_pause_seconds INTEGER NOT NULL DEFAULT 300,
        extractor_enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS campaign (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        spintax_template TEXT NOT NULL,
        links_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaign_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        weight INTEGER NOT NULL DEFAULT 1,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS campaign_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        url TEXT NOT NULL,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        resolved_title TEXT,
        resolved_members INTEGER,
        resolved_type TEXT,
        resolved_about TEXT,
        resolved_photo_b64 TEXT,
        resolved_at INTEGER,
        resolved_failed INTEGER
      );

      CREATE TABLE IF NOT EXISTS destinations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        weight INTEGER NOT NULL DEFAULT 1,
        is_enabled INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS link_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        link_id INTEGER NOT NULL,
        members INTEGER NOT NULL,
        checked_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_link_snapshots ON link_snapshots(link_id, checked_at);

      CREATE TABLE IF NOT EXISTS session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        session_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_state (
        chat_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        access_hash TEXT,
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
        template_id INTEGER,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        message_snippet TEXT NOT NULL,
        link_used TEXT NOT NULL,
        status TEXT NOT NULL,
        details TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_logs_created_at ON logs(created_at);

      CREATE TABLE IF NOT EXISTS extracted_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        domain TEXT,
        preview TEXT,
        source_chat_id TEXT NOT NULL,
        source_chat_title TEXT NOT NULL,
        message_id INTEGER,
        sender_id TEXT,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        times_seen INTEGER NOT NULL DEFAULT 1,
        resolved_title TEXT,
        resolved_members INTEGER,
        resolved_type TEXT,
        resolved_photo_b64 TEXT,
        resolved_about TEXT,
        resolved_at INTEGER,
        resolved_failed INTEGER,
        UNIQUE(kind, value)
      );

      CREATE INDEX IF NOT EXISTS idx_extracted_kind_seen ON extracted_items(kind, last_seen_at DESC);

      CREATE TABLE IF NOT EXISTS orchestrator_workers (
        worker_id TEXT PRIMARY KEY,
        api_url TEXT NOT NULL,
        groups_json TEXT NOT NULL,
        version TEXT,
        status_snapshot_json TEXT,
        meta_target INTEGER,
        last_heartbeat_at INTEGER,
        registered_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS orchestrator_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        chat_title TEXT NOT NULL,
        worker_id TEXT NOT NULL,
        granted_at INTEGER NOT NULL,
        lock_until INTEGER NOT NULL,
        result TEXT
      );

      -- Global values defined on the orchestration master (source of truth);
      -- absence of a row means the field falls back to the account's local value
      CREATE TABLE IF NOT EXISTS orchestrator_overrides (
        field TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      -- Local per-daemon key-value cache: holds the last global state pushed
      -- by the master (overrides + rebalanced round-target share) so effective
      -- config survives restarts and degraded periods without ever writing
      -- over the local config table
      CREATE TABLE IF NOT EXISTS orchestrator_state (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_grants_chat ON orchestrator_grants(chat_id, granted_at DESC);
    `);

    // Migrations for existing databases: ensure new columns exist
    try {
      this.db.exec('ALTER TABLE group_state ADD COLUMN access_hash TEXT');
    } catch {
      // Column already exists
    }
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

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN min_resend_interval_minutes INTEGER NOT NULL DEFAULT 10');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN extractor_enabled INTEGER NOT NULL DEFAULT 1');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN template_rotation_enabled INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE logs ADD COLUMN template_id INTEGER');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN member_tracking_enabled INTEGER NOT NULL DEFAULT 0');
    } catch {
      // Column already exists
    }

    try {
      this.db.exec('ALTER TABLE config ADD COLUMN member_tracking_interval_hours INTEGER NOT NULL DEFAULT 6');
    } catch {
      // Column already exists
    }

    // Orchestrator command channel: one pending command per worker plus the
    // last acknowledged result for panel feedback
    for (const ddl of [
      'ALTER TABLE orchestrator_workers ADD COLUMN pending_command_json TEXT',
      'ALTER TABLE orchestrator_workers ADD COLUMN last_command_ack_json TEXT',
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // Column already exists
      }
    }

    for (const ddl of [
      'ALTER TABLE campaign_links ADD COLUMN resolved_title TEXT',
      'ALTER TABLE campaign_links ADD COLUMN resolved_members INTEGER',
      'ALTER TABLE campaign_links ADD COLUMN resolved_type TEXT',
      'ALTER TABLE campaign_links ADD COLUMN resolved_about TEXT',
      'ALTER TABLE campaign_links ADD COLUMN resolved_photo_b64 TEXT',
      'ALTER TABLE campaign_links ADD COLUMN resolved_at INTEGER',
      'ALTER TABLE campaign_links ADD COLUMN resolved_failed INTEGER',
      'ALTER TABLE campaign_links ADD COLUMN destination_id INTEGER',
      'ALTER TABLE logs ADD COLUMN destination_id INTEGER',
      'ALTER TABLE campaigns ADD COLUMN destinations_migrated INTEGER NOT NULL DEFAULT 0',
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // Column already exists
      }
    }

    for (const ddl of [
      'ALTER TABLE extracted_items ADD COLUMN resolved_title TEXT',
      'ALTER TABLE extracted_items ADD COLUMN resolved_members INTEGER',
      'ALTER TABLE extracted_items ADD COLUMN resolved_type TEXT',
      'ALTER TABLE extracted_items ADD COLUMN resolved_photo_b64 TEXT',
      'ALTER TABLE extracted_items ADD COLUMN resolved_about TEXT',
      'ALTER TABLE extracted_items ADD COLUMN resolved_at INTEGER',
      'ALTER TABLE extracted_items ADD COLUMN resolved_failed INTEGER',
    ]) {
      try {
        this.db.exec(ddl);
      } catch {
        // Column already exists
      }
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

    // Seed the new campaign tables from the legacy single-row format
    this.migrateLegacyCampaign();

    // Group existing links into destinations (one-time per campaign)
    this.migrateDestinations();

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
      minResendIntervalMinutes: Number(
        row.min_resend_interval_minutes ?? DEFAULT_CONFIG.minResendIntervalMinutes,
      ),
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
      extractorEnabled: row.extractor_enabled === undefined
        ? DEFAULT_CONFIG.extractorEnabled : Boolean(row.extractor_enabled),
      templateRotationEnabled: row.template_rotation_enabled === undefined
        ? DEFAULT_CONFIG.templateRotationEnabled : Boolean(row.template_rotation_enabled),
      memberTrackingEnabled: row.member_tracking_enabled === undefined
        ? DEFAULT_CONFIG.memberTrackingEnabled : Boolean(row.member_tracking_enabled),
      memberTrackingIntervalHours: row.member_tracking_interval_hours === undefined
        ? DEFAULT_CONFIG.memberTrackingIntervalHours : Math.max(
          4, Number(row.member_tracking_interval_hours),
        ),
    };
  }

  // Global overrides defined on the orchestration master (source of truth).
  // Only whitelisted fields are readable here so unknown rows never leak
  listOverrides(): Partial<AutomationDbConfig> {
    const rows = this.db.prepare('SELECT field, value_json FROM orchestrator_overrides').all() as any[];
    const overrides: Record<string, unknown> = {};
    for (const row of rows) {
      const field = String(row.field);
      if (!OVERRIDEABLE_CONFIG_FIELDS[field as keyof AutomationDbConfig]) continue;
      try {
        overrides[field] = JSON.parse(String(row.value_json));
      } catch {
        // Corrupt row: treated as absent
      }
    }
    return overrides;
  }

  setOverride(field: string, value: string | number | boolean) {
    this.db.prepare(`
      INSERT INTO orchestrator_overrides (field, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(field) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(field, JSON.stringify(value), Math.floor(Date.now() / 1000));
  }

  clearOverride(field: string) {
    this.db.prepare('DELETE FROM orchestrator_overrides WHERE field = ?').run(field);
  }

  // Last global state pushed by the master (workers) or refreshed locally on
  // every master edit (master's own account). Persisted so effective config
  // survives restarts and degraded periods — the local config stays pristine
  getOrchestratorCache(): { overrides: Partial<AutomationDbConfig>; roundTargetShare?: number } {
    const raw = this.getStateJson('orchestrator-cache');
    if (!raw || typeof raw !== 'object') return { overrides: {} };
    const cache = raw as { overrides?: Record<string, unknown>; roundTargetShare?: unknown };
    const overrides: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(cache.overrides || {})) {
      if (!OVERRIDEABLE_CONFIG_FIELDS[field as keyof AutomationDbConfig]) continue;
      overrides[field] = value;
    }
    return {
      overrides,
      roundTargetShare: Number.isFinite(Number(cache.roundTargetShare))
        ? Number(cache.roundTargetShare) : undefined,
    };
  }

  saveOrchestratorCache(cache: { overrides: Partial<AutomationDbConfig>; roundTargetShare?: number }) {
    this.saveStateJson('orchestrator-cache', cache);
  }

  // Local config merged with active global overrides. `roundTargetSends` is
  // special: a global target is split across alive accounts by the master, so
  // the rebalanced share replaces it — the raw global value never reaches an
  // individual account's effective config
  getEffectiveConfig(): AutomationDbConfig {
    const cache = this.getOrchestratorCache();
    const effective = { ...this.getConfig() } as Record<string, unknown>;
    for (const [field, value] of Object.entries(cache.overrides)) {
      if (field === 'roundTargetSends') continue;
      if (!OVERRIDEABLE_CONFIG_FIELDS[field as keyof AutomationDbConfig]) continue;
      effective[field] = value;
    }
    if (cache.roundTargetShare !== undefined) {
      effective.roundTargetSends = Math.max(1, cache.roundTargetShare);
    }
    return effective as AutomationDbConfig;
  }

  getOverriddenFields(): string[] {
    const cache = this.getOrchestratorCache();
    const fields = new Set(Object.keys(cache.overrides));
    if (cache.roundTargetShare !== undefined) fields.add('roundTargetSends');
    return [...fields];
  }

  // Generic per-daemon state (JSON key-value) used for the orchestration cache
  // and the account identity captured at connect time
  getStateJson<T>(key: string): T | undefined {
    const row = this.db.prepare(
      'SELECT value_json FROM orchestrator_state WHERE key = ?',
    ).get(key) as any;
    if (!row) return undefined;
    try {
      return JSON.parse(String(row.value_json)) as T;
    } catch {
      return undefined;
    }
  }

  saveStateJson(key: string, value: unknown) {
    this.db.prepare(`
      INSERT INTO orchestrator_state (key, value_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(key, JSON.stringify(value), Math.floor(Date.now() / 1000));
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
        min_resend_interval_minutes = ?,
        sleep_window_enabled = ?,
        sleep_window_start = ?,
        sleep_window_end = ?,
        daily_limit = ?,
        link_preview_enabled = ?,
        micro_pause_enabled = ?,
        micro_pause_every_min = ?,
        micro_pause_every_max = ?,
        micro_pause_seconds = ?,
        extractor_enabled = ?,
        template_rotation_enabled = ?,
        member_tracking_enabled = ?,
        member_tracking_interval_hours = ?
      WHERE id = 1
    `).run(
      next.mode,
      next.minDelaySeconds,
      next.maxDelaySeconds,
      next.roundIntervalMinutes,
      next.roundTargetSends,
      next.minOtherMessages,
      next.minResendIntervalMinutes,
      next.sleepWindowEnabled ? 1 : 0,
      next.sleepWindowStart,
      next.sleepWindowEnd,
      next.dailyLimit,
      next.linkPreviewEnabled ? 1 : 0,
      next.microPauseEnabled ? 1 : 0,
      next.microPauseEveryMin,
      next.microPauseEveryMax,
      next.microPauseSeconds,
      next.extractorEnabled ? 1 : 0,
      next.templateRotationEnabled ? 1 : 0,
      next.memberTrackingEnabled ? 1 : 0,
      Math.max(4, Number(next.memberTrackingIntervalHours)),
    );

    return next;
  }

  getCampaigns(): { id: number; name: string; isActive: boolean; updatedAt: number }[] {
    const rows = this.db.prepare(
      'SELECT id, name, is_active, updated_at FROM campaigns ORDER BY id',
    ).all() as any[];
    return rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name),
      isActive: Boolean(row.is_active),
      updatedAt: Number(row.updated_at),
    }));
  }

  createCampaign(name: string): number {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(
      'INSERT INTO campaigns (name, is_active, created_at, updated_at) VALUES (?, 0, ?, ?)',
    ).run(name, now, now);
    const created = this.db.prepare('SELECT id FROM campaigns ORDER BY id DESC LIMIT 1').get() as any;
    return Number(created.id);
  }

  duplicateCampaign(sourceId: number, newName: string): number {
    const source = this.db.prepare('SELECT * FROM campaigns WHERE id = ?').get(sourceId) as any;
    const newId = this.createCampaign(newName || `${source?.name || 'Campanha'} (cópia)`);

    const templates = this.db.prepare(
      'SELECT * FROM campaign_templates WHERE campaign_id = ? ORDER BY position, id',
    ).all(sourceId) as any[];
    templates.forEach((row) => {
      this.saveCampaignTemplate({
        campaignId: newId,
        title: String(row.title),
        content: String(row.content),
        weight: Number(row.weight),
        isEnabled: Boolean(row.is_enabled),
      });
    });

    const destinations = this.db.prepare(
      'SELECT * FROM destinations WHERE campaign_id = ? ORDER BY position, id',
    ).all(sourceId) as any[];
    const destinationIdMap = new Map<number, number>();
    destinations.forEach((row) => {
      const copy = this.saveDestination({
        campaignId: newId,
        name: String(row.name),
        weight: Number(row.weight),
        isEnabled: Boolean(row.is_enabled),
      });
      destinationIdMap.set(Number(row.id), copy.id);
    });

    const links = this.db.prepare(
      'SELECT * FROM campaign_links WHERE campaign_id = ? ORDER BY position, id',
    ).all(sourceId) as any[];
    links.forEach((row) => {
      const sourceDestinationId = row.destination_id !== null && row.destination_id !== undefined
        ? Number(row.destination_id) : undefined;
      this.saveCampaignLink({
        campaignId: newId,
        url: String(row.url),
        isEnabled: Boolean(row.is_enabled),
        destinationId: sourceDestinationId !== undefined
          ? destinationIdMap.get(sourceDestinationId) : undefined,
      });
    });

    return newId;
  }

  renameCampaign(id: number, name: string) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('UPDATE campaigns SET name = ?, updated_at = ? WHERE id = ?').run(name, now, id);
  }

  activateCampaign(id: number) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('UPDATE campaigns SET is_active = 0').run();
    this.db.prepare('UPDATE campaigns SET is_active = 1, updated_at = ? WHERE id = ?').run(now, id);
  }

  // Logs-based aggregates for the performance dashboard
  getTemplateStats(sinceEpoch: number): { templateId: number; status: string; count: number }[] {
    const rows = this.db.prepare(`
      SELECT template_id, status, COUNT(*) AS count
      FROM logs
      WHERE template_id IS NOT NULL AND created_at >= ?
      GROUP BY template_id, status
    `).all(sinceEpoch) as any[];
    return rows.map((row) => ({
      templateId: Number(row.template_id),
      status: String(row.status),
      count: Number(row.count),
    }));
  }

  getChatStats(sinceEpoch: number): {
    chatId: string;
    chatTitle: string;
    attempts: number;
    successes: number;
  }[] {
    const rows = this.db.prepare(`
      SELECT chat_id, MAX(chat_title) AS title, COUNT(*) AS attempts,
        SUM(CASE WHEN status = 'SUCCESS' THEN 1 ELSE 0 END) AS successes
      FROM logs
      WHERE created_at >= ? AND chat_id != 'system'
      GROUP BY chat_id
      ORDER BY attempts DESC
      LIMIT 20
    `).all(sinceEpoch) as any[];
    return rows.map((row) => ({
      chatId: String(row.chat_id),
      chatTitle: String(row.title),
      attempts: Number(row.attempts),
      successes: Number(row.successes),
    }));
  }

  getHourlySuccess(sinceEpoch: number): { bucket: number; count: number }[] {
    const rows = this.db.prepare(`
      SELECT (created_at / 3600) * 3600 AS bucket, COUNT(*) AS count
      FROM logs
      WHERE status = 'SUCCESS' AND created_at >= ?
      GROUP BY bucket
    `).all(sinceEpoch) as any[];
    return rows.map((row) => ({
      bucket: Number(row.bucket),
      count: Number(row.count),
    }));
  }

  migrateLegacyCampaign() {
    const existing = this.db.prepare('SELECT COUNT(*) AS count FROM campaigns').get() as any;
    if (Number(existing.count) > 0) return;

    const campaignId = this.getOrCreateActiveCampaignId();

    const legacy = this.db.prepare('SELECT * FROM campaign WHERE id = 1').get() as any;
    if (!legacy) return;

    if (legacy.spintax_template) {
      this.saveCampaignTemplate({
        campaignId,
        title: 'Principal',
        content: String(legacy.spintax_template),
      });
    }

    try {
      const parsed = JSON.parse(String(legacy.links_json));
      const links = Array.isArray(parsed) ? parsed : [];
      links.forEach((url) => this.saveCampaignLink({ campaignId, url: String(url) }));
    } catch {
      // No legacy links to migrate
    }
  }

  // One-time per campaign: groups pre-destination links into destinations so
  // the user starts organized. Links with a resolved title are grouped by it
  // (each real group becomes a destination); the rest land in "Destino inicial"
  migrateDestinations() {
    const campaigns = this.db.prepare(
      'SELECT id FROM campaigns WHERE destinations_migrated = 0',
    ).all() as any[];

    for (const campaign of campaigns) {
      const campaignId = Number(campaign.id);
      const links = this.db.prepare(`
        SELECT id, resolved_title FROM campaign_links
        WHERE campaign_id = ? AND destination_id IS NULL
        ORDER BY position, id
      `).all(campaignId) as any[];

      const linkIdsByTitle = new Map<string, number[]>();
      for (const link of links) {
        const key = link.resolved_title ? String(link.resolved_title) : '';
        const bucket = linkIdsByTitle.get(key);
        if (bucket) bucket.push(Number(link.id));
        else linkIdsByTitle.set(key, [Number(link.id)]);
      }

      for (const [title, linkIds] of linkIdsByTitle) {
        const destination = this.saveDestination({
          campaignId,
          name: title || 'Destino inicial',
        });
        const update = this.db.prepare(
          'UPDATE campaign_links SET destination_id = ? WHERE id = ?',
        );
        linkIds.forEach((linkId) => update.run(destination.id, linkId));
      }

      this.db.prepare('UPDATE campaigns SET destinations_migrated = 1 WHERE id = ?').run(campaignId);
    }
  }

  private getOrCreateActiveCampaignId(): number {
    const active = this.db.prepare(
      'SELECT id FROM campaigns WHERE is_active = 1 ORDER BY id LIMIT 1',
    ).get() as any;
    if (active) return Number(active.id);

    const any = this.db.prepare('SELECT id FROM campaigns ORDER BY id LIMIT 1').get() as any;
    if (any) {
      this.db.prepare('UPDATE campaigns SET is_active = 1 WHERE id = ?').run(any.id);
      return Number(any.id);
    }

    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(
      'INSERT INTO campaigns (name, is_active, created_at, updated_at) VALUES (?, 1, ?, ?)',
    ).run('Padrão', now, now);
    const created = this.db.prepare('SELECT id FROM campaigns ORDER BY id DESC LIMIT 1').get() as any;
    return Number(created.id);
  }

  private touchCampaign(campaignId: number) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare('UPDATE campaigns SET updated_at = ? WHERE id = ?').run(now, campaignId);
  }

  private mapTemplateRow(row: any): CampaignTemplateRecord {
    return {
      id: Number(row.id),
      title: String(row.title),
      content: String(row.content),
      weight: Number(row.weight),
      isEnabled: Boolean(row.is_enabled),
      position: Number(row.position),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapDestinationRow(row: any): CampaignDestinationRecord {
    return {
      id: Number(row.id),
      name: String(row.name),
      weight: Number(row.weight),
      isEnabled: Boolean(row.is_enabled),
      position: Number(row.position),
      updatedAt: Number(row.updated_at),
    };
  }

  private mapLinkRow(row: any): CampaignLinkRecord {
    return {
      id: Number(row.id),
      url: String(row.url),
      isEnabled: Boolean(row.is_enabled),
      position: Number(row.position),
      updatedAt: Number(row.updated_at),
      destinationId: row.destination_id !== null && row.destination_id !== undefined
        ? Number(row.destination_id) : undefined,
      resolvedTitle: row.resolved_title ? String(row.resolved_title) : undefined,
      resolvedMembers: row.resolved_members !== null && row.resolved_members !== undefined
        ? Number(row.resolved_members) : undefined,
      resolvedType: row.resolved_type ? String(row.resolved_type) : undefined,
      resolvedAbout: row.resolved_about ? String(row.resolved_about) : undefined,
      resolvedPhotoB64: row.resolved_photo_b64 ? String(row.resolved_photo_b64) : undefined,
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
      resolvedFailed: Boolean(row.resolved_failed),
    };
  }

  getCampaign(): AutomationCampaign {
    const campaignId = this.getOrCreateActiveCampaignId();
    const campaignRow = this.db.prepare(
      'SELECT * FROM campaigns WHERE id = ?',
    ).get(campaignId) as any;

    const templates = (this.db.prepare(
      'SELECT * FROM campaign_templates WHERE campaign_id = ? ORDER BY position, id',
    ).all(campaignId) as any[]).map((row) => this.mapTemplateRow(row));

    const destinations = (this.db.prepare(
      'SELECT * FROM destinations WHERE campaign_id = ? ORDER BY position, id',
    ).all(campaignId) as any[]).map((row) => this.mapDestinationRow(row));

    const allLinks = (this.db.prepare(
      'SELECT * FROM campaign_links WHERE campaign_id = ? ORDER BY position, id',
    ).all(campaignId) as any[]).map((row) => this.mapLinkRow(row));

    const firstTemplate = templates.find((t) => t.isEnabled);

    return {
      id: campaignId,
      name: String(campaignRow.name),
      spintaxTemplate: firstTemplate?.content ?? '',
      templates,
      destinations,
      links: allLinks.filter((l) => l.isEnabled).map((l) => l.url),
      allLinks,
      updatedAt: Number(campaignRow.updated_at),
    };
  }

  saveCampaignTemplate(template: {
    id?: number;
    campaignId: number;
    title?: string;
    content: string;
    weight?: number;
    isEnabled?: boolean;
  }): CampaignTemplateRecord {
    const now = Math.floor(Date.now() / 1000);

    if (template.id) {
      this.db.prepare(`
        UPDATE campaign_templates SET
          title = ?, content = ?, weight = ?, is_enabled = ?, updated_at = ?
        WHERE id = ?
      `).run(
        template.title ?? '',
        template.content,
        Math.max(1, Number(template.weight ?? 1)),
        template.isEnabled === false ? 0 : 1,
        now,
        template.id,
      );
      this.touchCampaign(template.campaignId);
    } else {
      const posRow = this.db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM campaign_templates WHERE campaign_id = ?',
      ).get(template.campaignId) as any;
      this.db.prepare(`
        INSERT INTO campaign_templates (campaign_id, title, content, weight, is_enabled, position, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        template.campaignId,
        template.title ?? '',
        template.content,
        Math.max(1, Number(template.weight ?? 1)),
        template.isEnabled === false ? 0 : 1,
        Number(posRow.next),
        now,
      );
      this.touchCampaign(template.campaignId);
    }

    const row = template.id
      ? this.db.prepare('SELECT * FROM campaign_templates WHERE id = ?').get(template.id)
      : this.db.prepare(
        'SELECT * FROM campaign_templates WHERE campaign_id = ? ORDER BY id DESC LIMIT 1',
      ).get(template.campaignId);
    return this.mapTemplateRow(row);
  }

  deleteCampaignTemplate(id: number) {
    this.db.prepare('DELETE FROM campaign_templates WHERE id = ?').run(id);
  }

  saveDestination(destination: {
    id?: number;
    campaignId: number;
    name?: string;
    weight?: number;
    isEnabled?: boolean;
  }): CampaignDestinationRecord {
    const now = Math.floor(Date.now() / 1000);

    if (destination.id) {
      this.db.prepare(`
        UPDATE destinations SET
          name = coalesce(?, name),
          weight = ?,
          is_enabled = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        destination.name ?? null,
        Math.max(1, Number(destination.weight ?? 1)),
        destination.isEnabled === false ? 0 : 1,
        now,
        destination.id,
      );
      this.touchCampaign(destination.campaignId);
    } else {
      const posRow = this.db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM destinations WHERE campaign_id = ?',
      ).get(destination.campaignId) as any;
      this.db.prepare(`
        INSERT INTO destinations (campaign_id, name, weight, is_enabled, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        destination.campaignId,
        destination.name || 'Destino',
        Math.max(1, Number(destination.weight ?? 1)),
        destination.isEnabled === false ? 0 : 1,
        Number(posRow.next),
        now,
        now,
      );
      this.touchCampaign(destination.campaignId);
    }

    const row = destination.id
      ? this.db.prepare('SELECT * FROM destinations WHERE id = ?').get(destination.id)
      : this.db.prepare(
        'SELECT * FROM destinations WHERE campaign_id = ? ORDER BY id DESC LIMIT 1',
      ).get(destination.campaignId);
    return this.mapDestinationRow(row);
  }

  deleteCampaignDestination(id: number) {
    this.db.prepare('UPDATE campaign_links SET destination_id = NULL WHERE destination_id = ?').run(id);
    this.db.prepare('DELETE FROM destinations WHERE id = ?').run(id);
  }

  // Enables exactly one destination ("promote only this group now")
  focusDestination(id: number): boolean {
    const row = this.db.prepare('SELECT campaign_id FROM destinations WHERE id = ?').get(id) as any;
    if (!row) return false;

    this.db.prepare(`
      UPDATE destinations SET
        is_enabled = CASE WHEN id = ? THEN 1 ELSE 0 END,
        updated_at = ?
      WHERE campaign_id = ?
    `).run(id, Math.floor(Date.now() / 1000), Number(row.campaign_id));
    this.touchCampaign(Number(row.campaign_id));
    return true;
  }

  saveCampaignLink(link: {
    id?: number;
    campaignId: number;
    url: string;
    isEnabled?: boolean;
    destinationId?: number;
  }): CampaignLinkRecord {
    const now = Math.floor(Date.now() / 1000);

    if (link.id) {
      // Assignment is preserved on plain toggles (destinationId only set on insert)
      this.db.prepare(`
        UPDATE campaign_links SET url = ?, is_enabled = ?, updated_at = ? WHERE id = ?
      `).run(link.url, link.isEnabled === false ? 0 : 1, now, link.id);
      this.touchCampaign(link.campaignId);
    } else {
      const posRow = this.db.prepare(
        'SELECT COALESCE(MAX(position), -1) + 1 AS next FROM campaign_links WHERE campaign_id = ?',
      ).get(link.campaignId) as any;
      this.db.prepare(`
        INSERT INTO campaign_links (campaign_id, url, is_enabled, position, updated_at, destination_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        link.campaignId,
        link.url,
        link.isEnabled === false ? 0 : 1,
        Number(posRow.next),
        now,
        link.destinationId ?? null,
      );
      this.touchCampaign(link.campaignId);
    }

    const row = link.id
      ? this.db.prepare('SELECT * FROM campaign_links WHERE id = ?').get(link.id)
      : this.db.prepare(
        'SELECT * FROM campaign_links WHERE campaign_id = ? ORDER BY id DESC LIMIT 1',
      ).get(link.campaignId);
    return this.mapLinkRow(row);
  }

  deleteCampaignLink(id: number) {
    this.db.prepare('DELETE FROM campaign_links WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM link_snapshots WHERE link_id = ?').run(id);
  }

  // Records a successful destination resolution (or a confirmed dead link)
  markCampaignLinkResolved(
    id: number,
    resolved: {
      title?: string;
      members?: number;
      type?: string;
      photoB64?: string;
      about?: string;
      failed?: boolean;
    },
  ) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE campaign_links SET
        resolved_title = ?,
        resolved_members = ?,
        resolved_type = ?,
        resolved_about = ?,
        resolved_photo_b64 = ?,
        resolved_at = ?,
        resolved_failed = ?
      WHERE id = ?
    `).run(
      resolved.title ?? null,
      resolved.members ?? null,
      resolved.type ?? null,
      resolved.about ?? null,
      resolved.photoB64 ?? null,
      now,
      resolved.failed ? 1 : 0,
      id,
    );
  }

  addLinkSnapshot(linkId: number, members: number) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(
      'INSERT INTO link_snapshots (link_id, members, checked_at) VALUES (?, ?, ?)',
    ).run(linkId, members, now);
  }

  getLinkSnapshots(linkId: number, limit = 2): { members: number; checkedAt: number }[] {
    const rows = this.db.prepare(`
      SELECT members, checked_at FROM link_snapshots
      WHERE link_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?
    `).all(linkId, limit) as any[];
    return rows.map((row) => ({
      members: Number(row.members),
      checkedAt: Number(row.checked_at),
    }));
  }

  getLinkLastCheckedAt(linkId: number): number | undefined {
    const row = this.db.prepare(
      'SELECT MAX(checked_at) AS last FROM link_snapshots WHERE link_id = ?',
    ).get(linkId) as any;
    return row?.last ? Number(row.last) : undefined;
  }

  // Send counts per promoted link from the logs (successful sends only)
  getLinkUsageStats(): { url: string; total: number; last24h: number }[] {
    const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
    const rows = this.db.prepare(`
      SELECT link_used, COUNT(*) AS total,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last24h
      FROM logs
      WHERE status = 'SUCCESS' AND link_used != ''
      GROUP BY link_used
    `).all(dayAgo) as any[];
    return rows.map((row) => ({
      url: String(row.link_used),
      total: Number(row.total),
      last24h: Number(row.last24h || 0),
    }));
  }

  // Full content replace — used to sync a worker with the master's campaign.
  // `destinations` omitted (undefined) preserves local destinations, so legacy
  // callers only rewrite templates/links; when provided, it is the new truth
  // and links reference destinations by index into that array.
  replaceCampaignContent(
    campaignId: number,
    templates: { title?: string; content: string; weight?: number; isEnabled?: boolean }[],
    links: { url: string; isEnabled?: boolean; destinationIndex?: number }[],
    destinations?: { name: string; weight?: number; isEnabled?: boolean }[],
  ) {
    let destinationIds: number[] = [];
    if (destinations !== undefined) {
      this.db.prepare('DELETE FROM destinations WHERE campaign_id = ?').run(campaignId);
      destinationIds = destinations.map((destination) => this.saveDestination({
        campaignId,
        name: destination.name,
        weight: destination.weight,
        isEnabled: destination.isEnabled,
      }).id);
    }

    this.db.prepare('DELETE FROM campaign_templates WHERE campaign_id = ?').run(campaignId);
    this.db.prepare('DELETE FROM campaign_links WHERE campaign_id = ?').run(campaignId);
    templates.forEach((template) => this.saveCampaignTemplate({ campaignId, ...template }));
    links.forEach((link) => {
      this.saveCampaignLink({
        campaignId,
        url: link.url,
        isEnabled: link.isEnabled,
        destinationId: link.destinationIndex !== undefined
          ? destinationIds[link.destinationIndex] : undefined,
      });
    });
  }

  // Legacy single-template save (kept for backward-compatible sync payloads)
  saveCampaign(spintaxTemplate: string, links: string[]): AutomationCampaign {
    const campaignId = this.getOrCreateActiveCampaignId();
    this.replaceCampaignContent(
      campaignId,
      spintaxTemplate ? [{ title: 'Principal', content: spintaxTemplate }] : [],
      links.map((url) => ({ url })),
    );
    return this.getCampaign();
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
        chat_id, title, access_hash, last_sent_at, other_messages_count, slowmode_seconds,
        slowmode_next_send_date, stars_cost, status, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        title = excluded.title,
        access_hash = coalesce(excluded.access_hash, group_state.access_hash),
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
      record.accessHash ?? null,
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

  deleteGroupState(chatId: string) {
    this.db.prepare('DELETE FROM group_state WHERE chat_id = ?').run(chatId);
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
      accessHash: row.access_hash ? String(row.access_hash) : undefined,
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
      accessHash: row.access_hash ? String(row.access_hash) : undefined,
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
      INSERT INTO logs (
        created_at, template_id, destination_id, chat_id, chat_title,
        message_snippet, link_used, status, details
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      log.createdAt,
      log.templateId ?? null,
      log.destinationId ?? null,
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
      templateId: row.template_id !== null && row.template_id !== undefined
        ? Number(row.template_id) : undefined,
      destinationId: row.destination_id !== null && row.destination_id !== undefined
        ? Number(row.destination_id) : undefined,
      chatId: String(row.chat_id),
      chatTitle: String(row.chat_title),
      messageSnippet: String(row.message_snippet),
      linkUsed: String(row.link_used),
      status: row.status,
      details: row.details ? String(row.details) : undefined,
    }));
  }

  upsertExtractedItem(item: Omit<ExtractedItemRecord, 'firstSeenAt' | 'lastSeenAt' | 'timesSeen'>) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      INSERT INTO extracted_items (
        kind, value, domain, preview, source_chat_id, source_chat_title,
        message_id, sender_id, first_seen_at, last_seen_at, times_seen
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(kind, value) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        times_seen = extracted_items.times_seen + 1,
        source_chat_id = excluded.source_chat_id,
        source_chat_title = excluded.source_chat_title,
        message_id = excluded.message_id,
        sender_id = excluded.sender_id,
        preview = coalesce(extracted_items.preview, excluded.preview)
    `).run(
      item.kind,
      item.value,
      item.domain ?? null,
      item.preview ?? null,
      item.sourceChatId,
      item.sourceChatTitle,
      item.messageId ?? null,
      item.senderId ?? null,
      now,
      now,
    );
  }

  getExtractedItems(options: {
    kind?: string;
    query?: string;
    limit?: number;
    orderBy?: 'last_seen_at' | 'times_seen';
  } = {}): ExtractedItemRecord[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (options.kind) {
      conditions.push('kind = ?');
      params.push(options.kind);
    }
    if (options.query) {
      conditions.push('(value LIKE ? OR source_chat_title LIKE ?)');
      const like = `%${options.query}%`;
      params.push(like, like);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = options.orderBy === 'times_seen' ? 'times_seen DESC' : 'last_seen_at DESC';
    const limit = Math.min(500, Math.max(1, options.limit ?? 100));

    const rows = this.db.prepare(`
      SELECT * FROM extracted_items ${where} ORDER BY ${orderBy} LIMIT ?
    `).all(...params, limit) as any[];

    return rows.map((row) => ({
      kind: String(row.kind),
      value: String(row.value),
      domain: row.domain ? String(row.domain) : undefined,
      preview: row.preview ? String(row.preview) : undefined,
      sourceChatId: String(row.source_chat_id),
      sourceChatTitle: String(row.source_chat_title),
      messageId: row.message_id !== null && row.message_id !== undefined ? Number(row.message_id) : undefined,
      senderId: row.sender_id ? String(row.sender_id) : undefined,
      firstSeenAt: Number(row.first_seen_at),
      lastSeenAt: Number(row.last_seen_at),
      timesSeen: Number(row.times_seen),
      resolvedTitle: row.resolved_title ? String(row.resolved_title) : undefined,
      resolvedMembers: row.resolved_members !== null && row.resolved_members !== undefined
        ? Number(row.resolved_members) : undefined,
      resolvedType: row.resolved_type ? String(row.resolved_type) : undefined,
      resolvedPhotoB64: row.resolved_photo_b64 ? String(row.resolved_photo_b64) : undefined,
      resolvedAbout: row.resolved_about ? String(row.resolved_about) : undefined,
      resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
      resolvedFailed: Boolean(row.resolved_failed),
    }));
  }

  getExtractStats(): { kind: string; total: number; last24h: number; sourceChats: number }[] {
    const since = Math.floor(Date.now() / 1000) - 86400;
    const rows = this.db.prepare(`
      SELECT kind,
        COUNT(*) as total,
        SUM(CASE WHEN last_seen_at >= ? THEN 1 ELSE 0 END) as last_24h,
        COUNT(DISTINCT source_chat_id) as source_chats
      FROM extracted_items
      GROUP BY kind
    `).all(since) as any[];

    return rows.map((row) => ({
      kind: String(row.kind),
      total: Number(row.total),
      last24h: Number(row.last_24h || 0),
      sourceChats: Number(row.source_chats),
    }));
  }

  // Records a successful invite resolution (or a confirmed invalid invite)
  markExtractedResolved(
    kind: string,
    value: string,
    resolved: {
      title?: string;
      members?: number;
      type?: string;
      photoB64?: string;
      about?: string;
      failed?: boolean;
    },
  ) {
    const now = Math.floor(Date.now() / 1000);
    this.db.prepare(`
      UPDATE extracted_items SET
        resolved_title = ?,
        resolved_members = ?,
        resolved_type = ?,
        resolved_photo_b64 = ?,
        resolved_about = ?,
        resolved_at = ?,
        resolved_failed = ?
      WHERE kind = ? AND value = ?
    `).run(
      resolved.title ?? null,
      resolved.members ?? null,
      resolved.type ?? null,
      resolved.photoB64 ?? null,
      resolved.about ?? null,
      now,
      resolved.failed ? 1 : 0,
      kind,
      value,
    );
  }

  clearExtractedItems(kind?: string) {
    if (kind) {
      this.db.prepare('DELETE FROM extracted_items WHERE kind = ?').run(kind);
      return;
    }
    this.db.exec('DELETE FROM extracted_items');
  }

  getTodaySentCount(serverNow: number): number {
    const since = serverNow - 86400;
    const row = this.db.prepare(`
      SELECT count(*) as count FROM logs
      WHERE created_at >= ? AND status = 'SUCCESS'
    `).get(since) as any;
    return row ? Number(row.count) : 0;
  }

  // Raw accessor for modules with custom aggregates (e.g. orchestrator)
  rawDb(): DatabaseSync {
    return this.db;
  }

  close() {
    this.db.close();
  }
}

// ---- Campaign copy payload (orchestrator command channel) ----

export interface CampaignContentPayload {
  templates: { title?: string; content: string; weight?: number; isEnabled?: boolean }[];
  links: { url: string; isEnabled?: boolean; destinationIndex?: number }[];
  destinations?: { name: string; weight?: number; isEnabled?: boolean }[];
}

const CAMPAIGN_COPY_MAX_TEMPLATES = 50;
const CAMPAIGN_COPY_MAX_LINKS = 200;
const CAMPAIGN_COPY_MAX_DESTINATIONS = 50;
const CAMPAIGN_COPY_MAX_STRING_LENGTH = 4096;

function parseBoundedString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.length || value.length > CAMPAIGN_COPY_MAX_STRING_LENGTH) {
    return undefined;
  }
  return value;
}

// Validates a campaign copy payload from the wire so a malformed command can
// never sit in the queue or corrupt the target account's campaign tables.
// `destinationIndex` must stay inside the destination list it refers to
export function parseCampaignContentPayload(raw: unknown): CampaignContentPayload | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const source = raw as Record<string, unknown>;

  const templatesRaw = source.templates;
  const linksRaw = source.links;
  const destinationsRaw = source.destinations;
  if (!Array.isArray(templatesRaw) || !Array.isArray(linksRaw) || templatesRaw.length === 0) {
    return undefined;
  }
  if (templatesRaw.length > CAMPAIGN_COPY_MAX_TEMPLATES || linksRaw.length > CAMPAIGN_COPY_MAX_LINKS) {
    return undefined;
  }
  if (destinationsRaw !== undefined && (
    !Array.isArray(destinationsRaw) || destinationsRaw.length > CAMPAIGN_COPY_MAX_DESTINATIONS
  )) {
    return undefined;
  }

  const templates: CampaignContentPayload['templates'] = [];
  for (const item of templatesRaw) {
    if (!item || typeof item !== 'object') return undefined;
    const template = item as Record<string, unknown>;
    const content = parseBoundedString(template.content);
    if (!content) return undefined;
    const title = template.title === undefined || template.title === null
      ? undefined : parseBoundedString(template.title);
    if (title === undefined && template.title !== undefined && template.title !== null) return undefined;
    if (template.weight !== undefined && !Number.isFinite(Number(template.weight))) return undefined;
    templates.push({
      title,
      content,
      weight: template.weight === undefined ? undefined : Number(template.weight),
      isEnabled: template.isEnabled === undefined ? undefined : Boolean(template.isEnabled),
    });
  }

  const destinations: CampaignContentPayload['destinations'] = [];
  if (destinationsRaw !== undefined) {
    for (const item of destinationsRaw) {
      if (!item || typeof item !== 'object') return undefined;
      const destination = item as Record<string, unknown>;
      const name = parseBoundedString(destination.name);
      if (!name) return undefined;
      if (destination.weight !== undefined && !Number.isFinite(Number(destination.weight))) return undefined;
      destinations.push({
        name,
        weight: destination.weight === undefined ? undefined : Number(destination.weight),
        isEnabled: destination.isEnabled === undefined ? undefined : Boolean(destination.isEnabled),
      });
    }
  }

  const links: CampaignContentPayload['links'] = [];
  for (const item of linksRaw) {
    if (!item || typeof item !== 'object') return undefined;
    const link = item as Record<string, unknown>;
    const url = parseBoundedString(link.url);
    if (!url) return undefined;
    if (link.destinationIndex !== undefined) {
      const index = Number(link.destinationIndex);
      if (!Number.isInteger(index) || index < 0 || index >= destinations.length) return undefined;
    }
    links.push({
      url,
      isEnabled: link.isEnabled === undefined ? undefined : Boolean(link.isEnabled),
      destinationIndex: link.destinationIndex === undefined
        ? undefined : Number(link.destinationIndex),
    });
  }

  return { templates, links, destinations: destinationsRaw === undefined ? undefined : destinations };
}
