import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

/** Migration theo phiên bản (PRAGMA user_version). Chỉ thêm, không xóa dữ liệu cũ. */
const MIGRATIONS: ((db: DB) => void)[] = [
  // v1: lược đồ gốc
  (db) => db.exec(fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8')),
  // v2: thông tin clip trong phiên upload, tiến độ upload của thiết bị
  (db) =>
    db.exec(`
      ALTER TABLE upload_sessions ADD COLUMN meta TEXT;
      ALTER TABLE upload_sessions ADD COLUMN updated_at INTEGER;
      ALTER TABLE device_states ADD COLUMN uploads_pending INTEGER;
      ALTER TABLE device_states ADD COLUMN upload_progress INTEGER;
      CREATE INDEX IF NOT EXISTS ix_upload_sessions_user ON upload_sessions (user_id, status);
      CREATE INDEX IF NOT EXISTS ix_videos_owner ON videos (owner_user_id);
      CREATE INDEX IF NOT EXISTS ix_videos_room ON videos (room_id);
    `),
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Chạy fn trong một transaction (BEGIN IMMEDIATE để tránh tranh chấp ghi). */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
