import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, SCHEMA_VERSION } from '../src/db/database.ts';

test('CSDL phiên bản 1 được nâng lên phiên bản mới, giữ nguyên dữ liệu', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multicam-mig-'));
  const file = path.join(dir, 'old.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(fs.readFileSync(path.join(import.meta.dirname, '../src/db/schema.sql'), 'utf8'));
    old.exec(`PRAGMA user_version = 1;
      INSERT INTO users (id, first_name, last_name, email, phone, password_hash, role, active, created_at, updated_at)
      VALUES ('u_old', 'A', 'B', 'a@b.vn', '0900000001', 'x', 'remote', 1, 1, 1);`);
    old.close();

    const db = openDatabase(file);
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, SCHEMA_VERSION);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols('upload_sessions').includes('meta'));
    assert.ok(cols('device_states').includes('uploads_pending'));
    assert.equal((db.prepare(`SELECT email FROM users WHERE id = 'u_old'`).get() as { email: string }).email, 'a@b.vn');
    db.close();
    // Mở lại lần nữa không chạy migration trùng
    openDatabase(file).close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
