import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR, STORE_DIR } from './config.js';
import {
  AGENT_DEFAULTS_STATE_KEY,
  normalizeAgentSettings,
  pruneAgentSettings,
} from './agent-settings.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import type {
  EvenDevice,
  EvenPairingAttempt,
  EvenPairingCode,
  EvenTurn,
  EvenTurnState,
} from './evenhub/types.js';
import {
  AgentRuntime,
  AgentSettings,
  NewMessage,
  RegisteredGroup,
  ScheduledTask,
  TaskRunLog,
} from './types.js';

let db: Database.Database;

function createSchema(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS chats (
      jid TEXT PRIMARY KEY,
      name TEXT,
      last_message_time TEXT,
      channel TEXT,
      is_group INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT,
      chat_jid TEXT,
      sender TEXT,
      sender_name TEXT,
      content TEXT,
      timestamp TEXT,
      is_from_me INTEGER,
      is_bot_message INTEGER DEFAULT 0,
      even_turn_id TEXT,
      PRIMARY KEY (id, chat_jid),
      FOREIGN KEY (chat_jid) REFERENCES chats(jid)
    );
    CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);

    CREATE TABLE IF NOT EXISTS scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
    CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);

    CREATE TABLE IF NOT EXISTS task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    CREATE INDEX IF NOT EXISTS idx_task_run_logs ON task_run_logs(task_id, run_at);

    CREATE TABLE IF NOT EXISTS router_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      group_folder TEXT PRIMARY KEY,
      session_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS even_pairing_codes (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      code_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT
    );
    CREATE TABLE IF NOT EXISTS even_pairing_attempts (
      address TEXT PRIMARY KEY,
      failures INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS even_devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_sha256 TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_even_devices_active
      ON even_devices(revoked_at, created_at);
    CREATE TABLE IF NOT EXISTS even_turns (
      id TEXT PRIMARY KEY,
      device_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_sha256 TEXT NOT NULL,
      input_kind TEXT NOT NULL DEFAULT 'audio',
      audio_path TEXT NOT NULL UNIQUE,
      audio_duration_ms INTEGER NOT NULL,
      state TEXT NOT NULL,
      confirmation_decision TEXT,
      transcript TEXT,
      whatsapp_message_id TEXT UNIQUE,
      answer TEXT,
      error_code TEXT,
      error_message TEXT,
      stt_attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(device_id, idempotency_key),
      FOREIGN KEY (device_id) REFERENCES even_devices(id)
    );
    CREATE INDEX IF NOT EXISTS idx_even_turns_device_created
      ON even_turns(device_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_even_turns_state_updated
      ON even_turns(state, updated_at);
  `);

  // Add context_mode column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE scheduled_tasks ADD COLUMN context_mode TEXT DEFAULT 'isolated'`,
    );
  } catch {
    /* column already exists */
  }

  // Add script column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE scheduled_tasks ADD COLUMN script TEXT`);
  } catch {
    /* column already exists */
  }

  // Add is_bot_message column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE messages ADD COLUMN is_bot_message INTEGER DEFAULT 0`,
    );
    // Backfill: mark existing bot messages that used the content prefix pattern
    database
      .prepare(`UPDATE messages SET is_bot_message = 1 WHERE content LIKE ?`)
      .run(`${ASSISTANT_NAME}:%`);
  } catch {
    /* column already exists */
  }

  try {
    database.exec(`ALTER TABLE messages ADD COLUMN even_turn_id TEXT`);
    database.exec(
      `CREATE INDEX IF NOT EXISTS idx_messages_even_turn
       ON messages(even_turn_id)`,
    );
  } catch {
    /* column already exists */
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_messages_even_turn
     ON messages(even_turn_id)`,
  );

  // Add is_main column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN is_main INTEGER DEFAULT 0`,
    );
    // Backfill: existing rows with folder = 'main' are the main group
    database.exec(
      `UPDATE registered_groups SET is_main = 1 WHERE folder = 'main'`,
    );
  } catch {
    /* column already exists */
  }

  // Add runtime column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE registered_groups ADD COLUMN runtime TEXT`);
  } catch {
    /* column already exists */
  }

  // Add agent_settings column if it doesn't exist (migration for existing DBs)
  try {
    database.exec(
      `ALTER TABLE registered_groups ADD COLUMN agent_settings TEXT`,
    );
  } catch {
    /* column already exists */
  }

  // Add channel and is_group columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE chats ADD COLUMN channel TEXT`);
    database.exec(`ALTER TABLE chats ADD COLUMN is_group INTEGER DEFAULT 0`);
    // Backfill from JID patterns
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 1 WHERE jid LIKE '%@g.us'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'whatsapp', is_group = 0 WHERE jid LIKE '%@s.whatsapp.net'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'discord', is_group = 1 WHERE jid LIKE 'dc:%'`,
    );
    database.exec(
      `UPDATE chats SET channel = 'telegram', is_group = 0 WHERE jid LIKE 'tg:%'`,
    );
  } catch {
    /* columns already exist */
  }

  // Add reply context columns if they don't exist (migration for existing DBs)
  try {
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_message_id TEXT`);
    database.exec(
      `ALTER TABLE messages ADD COLUMN reply_to_message_content TEXT`,
    );
    database.exec(`ALTER TABLE messages ADD COLUMN reply_to_sender_name TEXT`);
  } catch {
    /* columns already exist */
  }

  // Align early EvenHub development databases with the durable protocol names.
  try {
    database.exec(
      `ALTER TABLE even_devices RENAME COLUMN last_seen_at TO last_used_at`,
    );
  } catch {
    /* already current or EvenHub table was just created */
  }
  try {
    database.exec(
      `ALTER TABLE even_turns RENAME COLUMN audio_sha256 TO request_sha256`,
    );
  } catch {
    /* already current or EvenHub table was just created */
  }
  try {
    database.exec(
      `ALTER TABLE even_turns RENAME COLUMN duration_ms TO audio_duration_ms`,
    );
  } catch {
    /* already current or EvenHub table was just created */
  }
  try {
    database.exec(`ALTER TABLE even_turns ADD COLUMN whatsapp_message_id TEXT`);
  } catch {
    /* column already exists */
  }
  database.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_even_turns_whatsapp_message
     ON even_turns(whatsapp_message_id)`,
  );
  try {
    database.exec(
      `ALTER TABLE even_turns ADD COLUMN stt_attempts INTEGER NOT NULL DEFAULT 0`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE even_turns ADD COLUMN confirmation_decision TEXT`,
    );
  } catch {
    /* column already exists */
  }
  try {
    database.exec(
      `ALTER TABLE even_turns ADD COLUMN input_kind TEXT NOT NULL DEFAULT 'audio'`,
    );
  } catch {
    /* column already exists */
  }
  // A 0.3 draft may have reached dispatching before the host was upgraded.
  // Re-open only turns that have never reserved a WhatsApp message.
  database.exec(
    `UPDATE even_turns
     SET state = 'awaiting_confirmation'
     WHERE state = 'dispatching' AND whatsapp_message_id IS NULL
       AND confirmation_decision IS NULL`,
  );
}

export function initDatabase(): void {
  const dbPath = path.join(STORE_DIR, 'messages.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  createSchema(db);

  // Migrate from JSON files if they exist
  migrateJsonState();
}

/** @internal - for tests only. Creates a fresh in-memory database. */
export function _initTestDatabase(): void {
  db = new Database(':memory:');
  createSchema(db);
}

/** @internal - for tests only. */
export function _closeDatabase(): void {
  db.close();
}

export function isDatabaseReady(): boolean {
  try {
    const result = db.prepare('SELECT 1 AS ready').get() as
      | { ready: number }
      | undefined;
    return result?.ready === 1;
  } catch {
    return false;
  }
}

/**
 * Store chat metadata only (no message content).
 * Used for all chats to enable group discovery without storing sensitive content.
 */
export function storeChatMetadata(
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
): void {
  const ch = channel ?? null;
  const group = isGroup === undefined ? null : isGroup ? 1 : 0;

  if (name) {
    // Update with name, preserving existing timestamp if newer
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        name = excluded.name,
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, name, timestamp, ch, group);
  } else {
    // Update timestamp only, preserve existing name if any
    db.prepare(
      `
      INSERT INTO chats (jid, name, last_message_time, channel, is_group) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        last_message_time = MAX(last_message_time, excluded.last_message_time),
        channel = COALESCE(excluded.channel, channel),
        is_group = COALESCE(excluded.is_group, is_group)
    `,
    ).run(chatJid, chatJid, timestamp, ch, group);
  }
}

/**
 * Update chat name without changing timestamp for existing chats.
 * New chats get the current time as their initial timestamp.
 * Used during group metadata sync.
 */
export function updateChatName(chatJid: string, name: string): void {
  db.prepare(
    `
    INSERT INTO chats (jid, name, last_message_time) VALUES (?, ?, ?)
    ON CONFLICT(jid) DO UPDATE SET name = excluded.name
  `,
  ).run(chatJid, name, new Date().toISOString());
}

export interface ChatInfo {
  jid: string;
  name: string;
  last_message_time: string;
  channel: string;
  is_group: number;
}

/**
 * Get all known chats, ordered by most recent activity.
 */
export function getAllChats(): ChatInfo[] {
  return db
    .prepare(
      `
    SELECT jid, name, last_message_time, channel, is_group
    FROM chats
    ORDER BY last_message_time DESC
  `,
    )
    .all() as ChatInfo[];
}

/**
 * Get timestamp of last group metadata sync.
 */
export function getLastGroupSync(): string | null {
  // Store sync time in a special chat entry
  const row = db
    .prepare(`SELECT last_message_time FROM chats WHERE jid = '__group_sync__'`)
    .get() as { last_message_time: string } | undefined;
  return row?.last_message_time || null;
}

/**
 * Record that group metadata was synced.
 */
export function setLastGroupSync(): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR REPLACE INTO chats (jid, name, last_message_time) VALUES ('__group_sync__', '__group_sync__', ?)`,
  ).run(now);
}

/**
 * Store a message with full content.
 * Only call this for registered groups where message history is needed.
 */
export function storeMessage(msg: NewMessage): void {
  const correlatedTurn = msg.even_turn_id
    ? { id: msg.even_turn_id }
    : getEvenTurnByWhatsAppMessageId(msg.id);
  const evenTurnId = correlatedTurn?.id ?? null;
  db.prepare(
    `INSERT OR REPLACE INTO messages
       (id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
        is_bot_message, even_turn_id, reply_to_message_id,
        reply_to_message_content, reply_to_sender_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    evenTurnId ? 0 : msg.is_bot_message ? 1 : 0,
    evenTurnId,
    msg.reply_to_message_id ?? null,
    msg.reply_to_message_content ?? null,
    msg.reply_to_sender_name ?? null,
  );
}

/**
 * Store a message directly.
 */
export function storeMessageDirect(msg: {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: boolean;
  is_bot_message?: boolean;
  even_turn_id?: string;
}): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages
       (id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
        is_bot_message, even_turn_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    msg.chat_jid,
    msg.sender,
    msg.sender_name,
    msg.content,
    msg.timestamp,
    msg.is_from_me ? 1 : 0,
    msg.is_bot_message ? 1 : 0,
    msg.even_turn_id ?? null,
  );
}

export function getNewMessages(
  jids: string[],
  lastTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): { messages: NewMessage[]; newTimestamp: string } {
  if (jids.length === 0) return { messages: [], newTimestamp: lastTimestamp };

  const placeholders = jids.map(() => '?').join(',');
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             even_turn_id,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE timestamp > ? AND chat_jid IN (${placeholders})
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;

  const rows = db
    .prepare(sql)
    .all(lastTimestamp, ...jids, `${botPrefix}:%`, limit) as NewMessage[];

  let newTimestamp = lastTimestamp;
  for (const row of rows) {
    if (row.timestamp > newTimestamp) newTimestamp = row.timestamp;
  }

  return { messages: rows, newTimestamp };
}

export function getMessagesSince(
  chatJid: string,
  sinceTimestamp: string,
  botPrefix: string,
  limit: number = 200,
): NewMessage[] {
  // Filter bot messages using both the is_bot_message flag AND the content
  // prefix as a backstop for messages written before the migration ran.
  // Subquery takes the N most recent, outer query re-sorts chronologically.
  const sql = `
    SELECT * FROM (
      SELECT id, chat_jid, sender, sender_name, content, timestamp, is_from_me,
             even_turn_id,
             reply_to_message_id, reply_to_message_content, reply_to_sender_name
      FROM messages
      WHERE chat_jid = ? AND timestamp > ?
        AND is_bot_message = 0 AND content NOT LIKE ?
        AND content != '' AND content IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT ?
    ) ORDER BY timestamp
  `;
  return db
    .prepare(sql)
    .all(chatJid, sinceTimestamp, `${botPrefix}:%`, limit) as NewMessage[];
}

export function getLastBotMessageTimestamp(
  chatJid: string,
  botPrefix: string,
): string | undefined {
  const row = db
    .prepare(
      `SELECT MAX(timestamp) as ts FROM messages
       WHERE chat_jid = ? AND (is_bot_message = 1 OR content LIKE ?)`,
    )
    .get(chatJid, `${botPrefix}:%`) as { ts: string | null } | undefined;
  return row?.ts ?? undefined;
}

export function getMessageContentById(
  id: string,
  chatJid: string,
): string | undefined {
  const row = db
    .prepare(`SELECT content FROM messages WHERE id = ? AND chat_jid = ?`)
    .get(id, chatJid) as { content: string } | undefined;
  return row?.content;
}

export function createTask(
  task: Omit<ScheduledTask, 'last_run' | 'last_result'>,
): void {
  db.prepare(
    `
    INSERT INTO scheduled_tasks (id, group_folder, chat_jid, prompt, script, schedule_type, schedule_value, context_mode, next_run, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  ).run(
    task.id,
    task.group_folder,
    task.chat_jid,
    task.prompt,
    task.script || null,
    task.schedule_type,
    task.schedule_value,
    task.context_mode || 'isolated',
    task.next_run,
    task.status,
    task.created_at,
  );
}

export function getTaskById(id: string): ScheduledTask | undefined {
  return db.prepare('SELECT * FROM scheduled_tasks WHERE id = ?').get(id) as
    | ScheduledTask
    | undefined;
}

export function getTasksForGroup(groupFolder: string): ScheduledTask[] {
  return db
    .prepare(
      'SELECT * FROM scheduled_tasks WHERE group_folder = ? ORDER BY created_at DESC',
    )
    .all(groupFolder) as ScheduledTask[];
}

export function getAllTasks(): ScheduledTask[] {
  return db
    .prepare('SELECT * FROM scheduled_tasks ORDER BY created_at DESC')
    .all() as ScheduledTask[];
}

export function updateTask(
  id: string,
  updates: Partial<
    Pick<
      ScheduledTask,
      | 'prompt'
      | 'script'
      | 'schedule_type'
      | 'schedule_value'
      | 'next_run'
      | 'status'
    >
  >,
): void {
  const fields: string[] = [];
  const values: unknown[] = [];

  if (updates.prompt !== undefined) {
    fields.push('prompt = ?');
    values.push(updates.prompt);
  }
  if (updates.script !== undefined) {
    fields.push('script = ?');
    values.push(updates.script || null);
  }
  if (updates.schedule_type !== undefined) {
    fields.push('schedule_type = ?');
    values.push(updates.schedule_type);
  }
  if (updates.schedule_value !== undefined) {
    fields.push('schedule_value = ?');
    values.push(updates.schedule_value);
  }
  if (updates.next_run !== undefined) {
    fields.push('next_run = ?');
    values.push(updates.next_run);
  }
  if (updates.status !== undefined) {
    fields.push('status = ?');
    values.push(updates.status);
  }

  if (fields.length === 0) return;

  values.push(id);
  db.prepare(
    `UPDATE scheduled_tasks SET ${fields.join(', ')} WHERE id = ?`,
  ).run(...values);
}

export function deleteTask(id: string): void {
  // Delete child records first (FK constraint)
  db.prepare('DELETE FROM task_run_logs WHERE task_id = ?').run(id);
  db.prepare('DELETE FROM scheduled_tasks WHERE id = ?').run(id);
}

export function getDueTasks(): ScheduledTask[] {
  const now = new Date().toISOString();
  return db
    .prepare(
      `
    SELECT * FROM scheduled_tasks
    WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?
    ORDER BY next_run
  `,
    )
    .all(now) as ScheduledTask[];
}

export function updateTaskAfterRun(
  id: string,
  nextRun: string | null,
  lastResult: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `
    UPDATE scheduled_tasks
    SET next_run = ?, last_run = ?, last_result = ?, status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
    WHERE id = ?
  `,
  ).run(nextRun, now, lastResult, nextRun, id);
}

export function logTaskRun(log: TaskRunLog): void {
  db.prepare(
    `
    INSERT INTO task_run_logs (task_id, run_at, duration_ms, status, result, error)
    VALUES (?, ?, ?, ?, ?, ?)
  `,
  ).run(
    log.task_id,
    log.run_at,
    log.duration_ms,
    log.status,
    log.result,
    log.error,
  );
}

// --- Router state accessors ---

export function getRouterState(key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM router_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setRouterState(key: string, value: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  ).run(key, value);
}

// --- Session accessors ---

export function getSession(groupFolder: string): string | undefined {
  const row = db
    .prepare('SELECT session_id FROM sessions WHERE group_folder = ?')
    .get(groupFolder) as { session_id: string } | undefined;
  return row?.session_id;
}

export function setSession(groupFolder: string, sessionId: string): void {
  db.prepare(
    'INSERT OR REPLACE INTO sessions (group_folder, session_id) VALUES (?, ?)',
  ).run(groupFolder, sessionId);
}

export function deleteSession(groupFolder: string): void {
  db.prepare('DELETE FROM sessions WHERE group_folder = ?').run(groupFolder);
}

export function getAllSessions(): Record<string, string> {
  const rows = db
    .prepare('SELECT group_folder, session_id FROM sessions')
    .all() as Array<{ group_folder: string; session_id: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.group_folder] = row.session_id;
  }
  return result;
}

// --- Registered group accessors ---

interface RegisteredGroupRow {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  added_at: string;
  container_config: string | null;
  requires_trigger: number | null;
  is_main: number | null;
  runtime: string | null;
  agent_settings: string | null;
}

function parseRuntime(v: string | null): AgentRuntime | undefined {
  return v === 'codex' || v === 'claude' ? v : undefined;
}

function parseAgentSettings(v: string | null): AgentSettings | undefined {
  if (!v) return undefined;
  try {
    const settings = normalizeAgentSettings(JSON.parse(v));
    return Object.keys(settings).length > 0 ? settings : undefined;
  } catch {
    return undefined;
  }
}

function rowToGroup(row: RegisteredGroupRow): RegisteredGroup {
  return {
    name: row.name,
    folder: row.folder,
    trigger: row.trigger_pattern,
    added_at: row.added_at,
    containerConfig: row.container_config
      ? JSON.parse(row.container_config)
      : undefined,
    requiresTrigger:
      row.requires_trigger === null ? undefined : row.requires_trigger === 1,
    isMain: row.is_main === 1 ? true : undefined,
    runtime: parseRuntime(row.runtime),
    agentSettings: parseAgentSettings(row.agent_settings),
  };
}

export function getRegisteredGroup(
  jid: string,
): (RegisteredGroup & { jid: string }) | undefined {
  const row = db
    .prepare('SELECT * FROM registered_groups WHERE jid = ?')
    .get(jid) as RegisteredGroupRow | undefined;
  if (!row) return undefined;
  if (!isValidGroupFolder(row.folder)) {
    logger.warn(
      { jid: row.jid, folder: row.folder },
      'Skipping registered group with invalid folder',
    );
    return undefined;
  }
  return { jid: row.jid, ...rowToGroup(row) };
}

export function setRegisteredGroup(jid: string, group: RegisteredGroup): void {
  if (!isValidGroupFolder(group.folder)) {
    throw new Error(`Invalid group folder "${group.folder}" for JID ${jid}`);
  }
  const agentSettings = pruneAgentSettings(group.agentSettings ?? {});
  db.prepare(
    `INSERT OR REPLACE INTO registered_groups (jid, name, folder, trigger_pattern, added_at, container_config, requires_trigger, is_main, runtime, agent_settings)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jid,
    group.name,
    group.folder,
    group.trigger,
    group.added_at,
    group.containerConfig ? JSON.stringify(group.containerConfig) : null,
    group.requiresTrigger === undefined ? 1 : group.requiresTrigger ? 1 : 0,
    group.isMain ? 1 : 0,
    group.runtime ?? null,
    Object.keys(agentSettings).length > 0
      ? JSON.stringify(agentSettings)
      : null,
  );
}

export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const rows = db
    .prepare('SELECT * FROM registered_groups')
    .all() as RegisteredGroupRow[];
  const result: Record<string, RegisteredGroup> = {};
  for (const row of rows) {
    if (!isValidGroupFolder(row.folder)) {
      logger.warn(
        { jid: row.jid, folder: row.folder },
        'Skipping registered group with invalid folder',
      );
      continue;
    }
    result[row.jid] = rowToGroup(row);
  }
  return result;
}

export function getAgentDefaultSettings(): AgentSettings {
  const raw = getRouterState(AGENT_DEFAULTS_STATE_KEY);
  if (!raw) return {};
  try {
    return normalizeAgentSettings(JSON.parse(raw));
  } catch {
    logger.warn('Corrupted agent default settings in DB, ignoring');
    return {};
  }
}

export function setAgentDefaultSettings(settings: AgentSettings): void {
  const pruned = pruneAgentSettings(settings);
  setRouterState(AGENT_DEFAULTS_STATE_KEY, JSON.stringify(pruned));
}

// --- EvenHub LAN bridge ---

export function replaceEvenPairingCode(code: EvenPairingCode): void {
  db.prepare(
    `INSERT OR REPLACE INTO even_pairing_codes
       (singleton, code_sha256, created_at, expires_at, consumed_at)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(code.code_sha256, code.created_at, code.expires_at, code.consumed_at);
}

export function getEvenPairingCode(): EvenPairingCode | undefined {
  return db
    .prepare(
      `SELECT code_sha256, created_at, expires_at, consumed_at
       FROM even_pairing_codes WHERE singleton = 1`,
    )
    .get() as EvenPairingCode | undefined;
}

export function getEvenPairingAttempt(
  address: string,
): EvenPairingAttempt | undefined {
  return db
    .prepare('SELECT * FROM even_pairing_attempts WHERE address = ?')
    .get(address) as EvenPairingAttempt | undefined;
}

export function recordEvenPairingFailure(
  address: string,
  now: Date,
  failureLimit = 5,
  lockMs = 15 * 60 * 1000,
): EvenPairingAttempt {
  const existing = getEvenPairingAttempt(address);
  const stillLocked =
    existing?.locked_until && Date.parse(existing.locked_until) > now.getTime();
  const expiredLock =
    existing?.locked_until &&
    Date.parse(existing.locked_until) <= now.getTime();
  const failures = stillLocked
    ? existing.failures
    : expiredLock
      ? 1
      : (existing?.failures ?? 0) + 1;
  const lockedUntil =
    stillLocked || failures >= failureLimit
      ? existing?.locked_until || new Date(now.getTime() + lockMs).toISOString()
      : null;
  const attempt: EvenPairingAttempt = {
    address,
    failures,
    locked_until: lockedUntil,
    updated_at: now.toISOString(),
  };
  db.prepare(
    `INSERT INTO even_pairing_attempts
       (address, failures, locked_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET
       failures = excluded.failures,
       locked_until = excluded.locked_until,
       updated_at = excluded.updated_at`,
  ).run(
    attempt.address,
    attempt.failures,
    attempt.locked_until,
    attempt.updated_at,
  );
  return attempt;
}

export function clearEvenPairingFailures(address: string): void {
  db.prepare('DELETE FROM even_pairing_attempts WHERE address = ?').run(
    address,
  );
}

export function activateEvenDeviceFromPairingCode(
  codeSha256: string,
  device: EvenDevice,
  now: string,
): boolean {
  return db.transaction(() => {
    const consumed = db
      .prepare(
        `UPDATE even_pairing_codes SET consumed_at = ?
         WHERE singleton = 1
           AND code_sha256 = ?
           AND consumed_at IS NULL
           AND expires_at > ?`,
      )
      .run(now, codeSha256, now);
    if (consumed.changes !== 1) return false;

    db.prepare(
      'UPDATE even_devices SET revoked_at = ? WHERE revoked_at IS NULL',
    ).run(now);
    db.prepare(
      `INSERT INTO even_devices
         (id, name, token_sha256, created_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      device.id,
      device.name,
      device.token_sha256,
      device.created_at,
      device.last_used_at,
      device.revoked_at,
    );
    return true;
  })();
}

export function getActiveEvenDevices(): EvenDevice[] {
  return db
    .prepare(
      'SELECT * FROM even_devices WHERE revoked_at IS NULL ORDER BY created_at',
    )
    .all() as EvenDevice[];
}

export function touchEvenDevice(id: string, now: string): void {
  db.prepare(
    'UPDATE even_devices SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL',
  ).run(now, id);
}

export function revokeAllEvenDevices(now: string): number {
  return db
    .prepare('UPDATE even_devices SET revoked_at = ? WHERE revoked_at IS NULL')
    .run(now).changes;
}

export type NewEvenTurn = Pick<
  EvenTurn,
  | 'id'
  | 'device_id'
  | 'idempotency_key'
  | 'request_sha256'
  | 'audio_path'
  | 'audio_duration_ms'
  | 'state'
  | 'created_at'
  | 'updated_at'
> &
  Partial<
    Pick<EvenTurn, 'input_kind' | 'confirmation_decision' | 'transcript'>
  >;

export function insertEvenTurn(turn: NewEvenTurn): void {
  db.prepare(
    `INSERT INTO even_turns
       (id, device_id, idempotency_key, request_sha256, input_kind, audio_path,
        audio_duration_ms, state, confirmation_decision, transcript,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    turn.id,
    turn.device_id,
    turn.idempotency_key,
    turn.request_sha256,
    turn.input_kind ?? 'audio',
    turn.audio_path,
    turn.audio_duration_ms,
    turn.state,
    turn.confirmation_decision ?? null,
    turn.transcript ?? null,
    turn.created_at,
    turn.updated_at,
  );
}

export function getEvenTurnById(id: string): EvenTurn | undefined {
  return db.prepare('SELECT * FROM even_turns WHERE id = ?').get(id) as
    | EvenTurn
    | undefined;
}

export function getEvenTurnForDevice(
  id: string,
  deviceId: string,
): EvenTurn | undefined {
  return db
    .prepare('SELECT * FROM even_turns WHERE id = ? AND device_id = ?')
    .get(id, deviceId) as EvenTurn | undefined;
}

export function getEvenTurnByIdempotencyKey(
  deviceId: string,
  idempotencyKey: string,
): EvenTurn | undefined {
  return db
    .prepare(
      `SELECT * FROM even_turns
       WHERE device_id = ? AND idempotency_key = ?`,
    )
    .get(deviceId, idempotencyKey) as EvenTurn | undefined;
}

export function transitionEvenTurnState(
  id: string,
  expectedState: EvenTurnState | readonly EvenTurnState[],
  state: EvenTurnState,
  fields: {
    transcript?: string;
    whatsappMessageId?: string;
    answer?: string;
    errorCode?: string;
    errorMessage?: string;
    completedAt?: string;
  } = {},
): boolean {
  const now = new Date().toISOString();
  const expectedStates: readonly EvenTurnState[] =
    typeof expectedState === 'string' ? [expectedState] : expectedState;
  if (expectedStates.length === 0) return false;
  const legalTransitions: Record<EvenTurnState, readonly EvenTurnState[]> = {
    accepted: ['transcribing', 'failed'],
    transcribing: ['awaiting_confirmation', 'failed'],
    awaiting_confirmation: ['dispatching', 'discarded'],
    dispatching: ['queued', 'failed'],
    queued: ['running', 'failed'],
    running: ['completed', 'failed'],
    completed: [],
    failed: [],
    discarded: [],
  };
  if (
    expectedStates.some(
      (expected) => !legalTransitions[expected].includes(state),
    ) ||
    (fields.answer !== undefined && state !== 'completed')
  ) {
    return false;
  }
  const placeholders = expectedStates.map(() => '?').join(', ');
  return (
    db
      .prepare(
        `UPDATE even_turns SET
           state = ?,
           transcript = COALESCE(?, transcript),
           whatsapp_message_id = COALESCE(?, whatsapp_message_id),
           answer = CASE
             WHEN state = 'completed' THEN answer
             ELSE COALESCE(?, answer)
           END,
           error_code = COALESCE(?, error_code),
           error_message = COALESCE(?, error_message),
           completed_at = COALESCE(?, completed_at),
           updated_at = ?
         WHERE id = ? AND state IN (${placeholders})`,
      )
      .run(
        state,
        fields.transcript ?? null,
        fields.whatsappMessageId ?? null,
        fields.answer ?? null,
        fields.errorCode ?? null,
        fields.errorMessage ?? null,
        fields.completedAt ?? null,
        now,
        id,
        ...expectedStates,
      ).changes === 1
  );
}

export type EvenTurnConfirmationResult =
  | { status: 'resolved' | 'idempotent'; turn: EvenTurn }
  | { status: 'conflict'; turn: EvenTurn };

/** Atomically resolves a draft. The recorded decision makes retries unambiguous. */
export function resolveEvenTurnConfirmation(
  id: string,
  decision: 'send' | 'discard',
): EvenTurnConfirmationResult | undefined {
  const resolve = db.transaction((): EvenTurnConfirmationResult | undefined => {
    const turn = getEvenTurnById(id);
    if (!turn) return undefined;
    if (turn.confirmation_decision) {
      return {
        status:
          turn.confirmation_decision === decision ? 'idempotent' : 'conflict',
        turn,
      };
    }
    if (turn.state !== 'awaiting_confirmation') {
      return { status: 'conflict', turn };
    }

    const now = new Date().toISOString();
    const nextState = decision === 'send' ? 'dispatching' : 'discarded';
    const changed = db
      .prepare(
        `UPDATE even_turns
         SET state = ?, confirmation_decision = ?, updated_at = ?,
             completed_at = CASE WHEN ? = 'discard' THEN ? ELSE completed_at END
         WHERE id = ? AND state = 'awaiting_confirmation'
           AND confirmation_decision IS NULL`,
      )
      .run(nextState, decision, now, decision, now, id).changes;
    const resolved = getEvenTurnById(id)!;
    if (changed === 1) return { status: 'resolved', turn: resolved };
    return {
      status:
        resolved.confirmation_decision === decision ? 'idempotent' : 'conflict',
      turn: resolved,
    };
  });
  return resolve();
}

export function reconcileEvenSttTurns(): number {
  const now = new Date().toISOString();
  return db
    .prepare(
      `UPDATE even_turns
       SET state = 'accepted', updated_at = ?
       WHERE state = 'transcribing' AND input_kind = 'audio'`,
    )
    .run(now).changes;
}

export function claimNextAcceptedEvenTurn(): EvenTurn | undefined {
  return db.transaction(() => {
    const candidate = db
      .prepare(
        `SELECT id FROM even_turns
         WHERE state = 'accepted' AND input_kind = 'audio'
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
      )
      .get() as { id: string } | undefined;
    if (!candidate) return undefined;

    const now = new Date().toISOString();
    const claimed = db
      .prepare(
        `UPDATE even_turns SET state = 'transcribing', updated_at = ?
         WHERE id = ? AND state = 'accepted'`,
      )
      .run(now, candidate.id);
    if (claimed.changes !== 1) return undefined;
    return getEvenTurnById(candidate.id);
  })();
}

export function incrementEvenTurnSttAttempts(id: string): number {
  const now = new Date().toISOString();
  const updated = db
    .prepare(
      `UPDATE even_turns
       SET stt_attempts = stt_attempts + 1, updated_at = ?
       WHERE id = ? AND state = 'transcribing'
       RETURNING stt_attempts`,
    )
    .get(now, id) as { stt_attempts: number } | undefined;
  return updated?.stt_attempts ?? 0;
}

export function getEvenTurnByWhatsAppMessageId(
  messageId: string,
): EvenTurn | undefined {
  return db
    .prepare('SELECT * FROM even_turns WHERE whatsapp_message_id = ?')
    .get(messageId) as EvenTurn | undefined;
}

export function getEvenTurnsByStates(
  states: readonly EvenTurnState[],
): EvenTurn[] {
  if (states.length === 0) return [];
  const placeholders = states.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT * FROM even_turns
       WHERE state IN (${placeholders})
       ORDER BY created_at ASC, id ASC`,
    )
    .all(...states) as EvenTurn[];
}

export function getNextEvenTurnToDispatch(): EvenTurn | undefined {
  return db
    .prepare(
      `SELECT * FROM even_turns
       WHERE state = 'dispatching'
         AND whatsapp_message_id IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM even_turns active
           WHERE active.state IN ('queued', 'running')
         )
       ORDER BY created_at ASC, id ASC
       LIMIT 1`,
    )
    .get() as EvenTurn | undefined;
}

export function reserveEvenTurnWhatsAppMessage(
  turnId: string,
  messageId: string,
): boolean {
  const now = new Date().toISOString();
  return (
    db
      .prepare(
        `UPDATE even_turns
         SET whatsapp_message_id = ?, updated_at = ?
         WHERE id = ? AND state = 'dispatching'
           AND whatsapp_message_id IS NULL`,
      )
      .run(messageId, now, turnId).changes === 1
  );
}

export function hasStoredEvenTurnPrompt(
  turnId: string,
  messageId: string,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM messages
         WHERE id = ? AND even_turn_id = ?
         LIMIT 1`,
      )
      .get(messageId, turnId),
  );
}

export function markEvenTurnQueuedAfterPrompt(
  turnId: string,
  messageId: string,
): boolean {
  return db.transaction(() => {
    if (!hasStoredEvenTurnPrompt(turnId, messageId)) return false;
    const now = new Date().toISOString();
    return (
      db
        .prepare(
          `UPDATE even_turns SET state = 'queued', updated_at = ?
           WHERE id = ? AND state = 'dispatching'
             AND whatsapp_message_id = ?`,
        )
        .run(now, turnId, messageId).changes === 1
    );
  })();
}

export function getEvenTurnsForChat(
  chatJid: string,
  states: readonly EvenTurnState[],
): EvenTurn[] {
  if (states.length === 0) return [];
  const placeholders = states.map(() => '?').join(', ');
  return db
    .prepare(
      `SELECT DISTINCT turn.*
       FROM even_turns turn
       JOIN messages message ON message.even_turn_id = turn.id
       WHERE message.chat_jid = ? AND turn.state IN (${placeholders})
       ORDER BY turn.created_at ASC, turn.id ASC`,
    )
    .all(chatJid, ...states) as EvenTurn[];
}

export function getExpiredEvenTurns(cutoff: string): EvenTurn[] {
  return db
    .prepare(
      `SELECT * FROM even_turns
       WHERE state IN ('awaiting_confirmation', 'completed', 'failed', 'discarded')
         AND COALESCE(completed_at, updated_at) < ?
       ORDER BY COALESCE(completed_at, updated_at) ASC`,
    )
    .all(cutoff) as EvenTurn[];
}

export function deleteExpiredEvenTurn(id: string, cutoff: string): boolean {
  return (
    db
      .prepare(
        `DELETE FROM even_turns
         WHERE id = ?
           AND state IN ('awaiting_confirmation', 'completed', 'failed', 'discarded')
           AND COALESCE(completed_at, updated_at) < ?`,
      )
      .run(id, cutoff).changes === 1
  );
}

export function getReferencedEvenAudioPaths(): string[] {
  return (
    db
      .prepare("SELECT audio_path FROM even_turns WHERE input_kind = 'audio'")
      .all() as Array<{
      audio_path: string;
    }>
  ).map((row) => row.audio_path);
}

// --- JSON migration ---

function migrateJsonState(): void {
  const migrateFile = (filename: string) => {
    const filePath = path.join(DATA_DIR, filename);
    if (!fs.existsSync(filePath)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      fs.renameSync(filePath, `${filePath}.migrated`);
      return data;
    } catch {
      return null;
    }
  };

  // Migrate router_state.json
  const routerState = migrateFile('router_state.json') as {
    last_timestamp?: string;
    last_agent_timestamp?: Record<string, string>;
  } | null;
  if (routerState) {
    if (routerState.last_timestamp) {
      setRouterState('last_timestamp', routerState.last_timestamp);
    }
    if (routerState.last_agent_timestamp) {
      setRouterState(
        'last_agent_timestamp',
        JSON.stringify(routerState.last_agent_timestamp),
      );
    }
  }

  // Migrate sessions.json
  const sessions = migrateFile('sessions.json') as Record<
    string,
    string
  > | null;
  if (sessions) {
    for (const [folder, sessionId] of Object.entries(sessions)) {
      setSession(folder, sessionId);
    }
  }

  // Migrate registered_groups.json
  const groups = migrateFile('registered_groups.json') as Record<
    string,
    RegisteredGroup
  > | null;
  if (groups) {
    for (const [jid, group] of Object.entries(groups)) {
      try {
        setRegisteredGroup(jid, group);
      } catch (err) {
        logger.warn(
          { jid, folder: group.folder, err },
          'Skipping migrated registered group with invalid folder',
        );
      }
    }
  }
}
