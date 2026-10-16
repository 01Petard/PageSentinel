import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Monitor, CheckRun, ChangeEvent } from "../../../shared/types.js";

export type Db = Database.Database;
export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY, config_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      enabled INTEGER NOT NULL, baseline_snapshot_id INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL,
      last_checked_at INTEGER, last_changed_at INTEGER, last_status TEXT, last_error TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_monitor_due ON monitors(enabled, next_run_at);
    CREATE TABLE IF NOT EXISTS snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL, content_json TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_snapshot_monitor ON snapshots(monitor_id, id);
    CREATE TABLE IF NOT EXISTS seen_items (
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      item_key TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
      PRIMARY KEY(monitor_id, item_key)
    );
    CREATE TABLE IF NOT EXISTS check_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      status TEXT NOT NULL, duration_ms INTEGER NOT NULL, error_code TEXT, error_message TEXT, checked_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_check_monitor ON check_runs(monitor_id, id DESC);
    CREATE TABLE IF NOT EXISTS change_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      type TEXT NOT NULL, detail_json TEXT NOT NULL, notification_status TEXT NOT NULL DEFAULT 'PENDING',
      notification_attempts INTEGER NOT NULL DEFAULT 0, next_notification_at INTEGER NOT NULL,
      notification_error TEXT, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_event_monitor ON change_events(monitor_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_notification_due ON change_events(notification_status, next_notification_at);
    CREATE TABLE IF NOT EXISTS monitor_previews (
      monitor_id TEXT PRIMARY KEY REFERENCES monitors(id) ON DELETE CASCADE,
      image BLOB NOT NULL, captured_at INTEGER NOT NULL
    );
  `);
  // Existing installations are upgraded in place without replacing their data.
  db.transaction(() => {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(check_runs)").all() as { name: string }[]
      ).map((row) => row.name),
    );
    if (!columns.has("source"))
      db.exec(
        "ALTER TABLE check_runs ADD COLUMN source TEXT NOT NULL DEFAULT 'LEGACY'",
      );
    if (!columns.has("summary"))
      db.exec("ALTER TABLE check_runs ADD COLUMN summary TEXT");
    const monitorColumns = new Set(
      (
        db.prepare("PRAGMA table_info(monitors)").all() as { name: string }[]
      ).map((row) => row.name),
    );
    if (!monitorColumns.has("last_success_at"))
      db.exec("ALTER TABLE monitors ADD COLUMN last_success_at INTEGER");
    db.pragma("user_version = 2");
  })();
  return db;
}

export function monitorFromRow(row: any): Monitor {
  return {
    ...JSON.parse(row.config_json),
    id: row.id,
    revision: row.revision,
    enabled: Boolean(row.enabled),
    baselineSnapshotId: row.baseline_snapshot_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextRunAt: row.next_run_at,
    lastCheckedAt: row.last_checked_at,
    lastChangedAt: row.last_changed_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    failureCount: row.failure_count,
  };
}
export function checkFromRow(row: any): CheckRun {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    status: row.status,
    durationMs: row.duration_ms,
    source: row.source,
    summary: row.summary,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    checkedAt: row.checked_at,
  };
}
export function eventFromRow(row: any): ChangeEvent {
  return {
    id: row.id,
    monitorId: row.monitor_id,
    type: row.type,
    detail: JSON.parse(row.detail_json),
    notificationStatus: row.notification_status,
    notificationAttempts: row.notification_attempts,
    nextNotificationAt: row.next_notification_at,
    notificationError: row.notification_error,
    createdAt: row.created_at,
  };
}
