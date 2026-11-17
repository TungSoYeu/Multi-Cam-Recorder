import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type DB = DatabaseSync;

const SCHEMA_VERSION = 1;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  if (row.user_version >= SCHEMA_VERSION) return;
  const sql = fs.readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8');
  tx(db, () => {
    db.exec(sql);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
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
