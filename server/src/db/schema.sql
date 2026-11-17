-- Multi-Cam Recorder — lược đồ CSDL (SQLite)
-- Thời gian lưu dạng epoch milliseconds (INTEGER). ID dạng chuỗi có tiền tố: u_, dv_, rm_, mb_, ...

-- ===== A. Tài khoản và phiên =====
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  first_name          TEXT NOT NULL,
  last_name           TEXT NOT NULL,
  email               TEXT NOT NULL UNIQUE,
  phone               TEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,
  role                TEXT NOT NULL CHECK (role IN ('controller', 'remote')),
  active              INTEGER NOT NULL DEFAULT 0,          -- 1 = đã xác thực mã
  locked              INTEGER NOT NULL DEFAULT 0,          -- 1 = tài khoản bị khóa
  storage_quota_bytes INTEGER NOT NULL DEFAULT 21474836480, -- 20 GB
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
-- Hệ thống chỉ có duy nhất MỘT tài khoản Controller.
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_single_controller ON users (role) WHERE role = 'controller';

-- Thiết bị đã đăng nhập của một tài khoản (đăng ký trong login).
CREATE TABLE IF NOT EXISTS devices (
  id               TEXT PRIMARY KEY,                      -- dv_xxx (server cấp)
  user_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_device_id TEXT NOT NULL,                         -- UUID sinh ở client lần đầu chạy
  device_type      INTEGER NOT NULL CHECK (device_type IN (1, 2, 4)), -- 1 android, 2 ios, 4 web
  device_name      TEXT NOT NULL,
  camera_name      TEXT NOT NULL,
  last_seen_at     INTEGER,
  created_at       INTEGER NOT NULL,
  UNIQUE (user_id, client_device_id)
);

-- Phiên đăng nhập: chỉ lưu hash của token. Refresh token dùng một lần (rotation).
CREATE TABLE IF NOT EXISTS sessions (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id          TEXT REFERENCES devices (id) ON DELETE CASCADE,
  access_hash        TEXT NOT NULL UNIQUE,
  access_expires_at  INTEGER NOT NULL,
  refresh_hash       TEXT NOT NULL UNIQUE,
  prev_refresh_hash  TEXT,                                -- phát hiện dùng lại refresh token cũ
  refresh_expires_at INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  revoked_at         INTEGER
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_prev_refresh ON sessions (prev_refresh_hash);

-- Mã xác thực 6 số gửi qua email/SMS (signup | forgot_password).
CREATE TABLE IF NOT EXISTS verify_codes (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('signup', 'forgot_password')),
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_verify_codes_user ON verify_codes (user_id, purpose, created_at);

-- Token push notification của thiết bị (phục vụ push).
CREATE TABLE IF NOT EXISTS push_tokens (
  device_id  TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  platform   TEXT NOT NULL,
  token      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ===== B. Phòng và ghép nối =====
CREATE TABLE IF NOT EXISTS rooms (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  invite_code       TEXT NOT NULL,
  invite_expires_at INTEGER NOT NULL,
  max_members       INTEGER NOT NULL DEFAULT 8,
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at        INTEGER NOT NULL,
  closed_at         INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_open_owner ON rooms (owner_id) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS ux_rooms_open_code ON rooms (invite_code) WHERE status = 'open';

CREATE TABLE IF NOT EXISTS room_members (
  id              TEXT PRIMARY KEY,                       -- mb_xxx
  room_id         TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  camera_name     TEXT NOT NULL,
  control_granted INTEGER NOT NULL DEFAULT 1,             -- đồng ý cấp quyền điều khiển quay
  joined_at       INTEGER NOT NULL,
  left_at         INTEGER,
  left_reason     TEXT CHECK (left_reason IN ('left', 'kicked', 'closed', 'logout'))
);
-- Một thiết bị chỉ ở trong tối đa một phòng tại một thời điểm.
CREATE UNIQUE INDEX IF NOT EXISTS ux_members_active_device ON room_members (device_id) WHERE left_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_members_room ON room_members (room_id, left_at);

-- ===== C. Đồng bộ trạng thái và điều khiển quay (tuần 2–3) =====
CREATE TABLE IF NOT EXISTS device_states (
  device_id          TEXT PRIMARY KEY REFERENCES devices (id) ON DELETE CASCADE,
  camera_facing      TEXT NOT NULL DEFAULT 'back' CHECK (camera_facing IN ('front', 'back')),
  is_recording       INTEGER NOT NULL DEFAULT 0,
  battery_level      INTEGER,
  free_storage_bytes INTEGER,
  resolution         TEXT,
  fps                INTEGER,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS recording_sessions (
  id         TEXT PRIMARY KEY,                            -- rs_xxx
  room_id    TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('recording', 'stopped')),
  started_at INTEGER NOT NULL,
  stopped_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_recording_active ON recording_sessions (room_id) WHERE status = 'recording';

CREATE TABLE IF NOT EXISTS commands (
  id                TEXT PRIMARY KEY,                     -- cmd_xxx
  room_id           TEXT NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  target_device_id  TEXT REFERENCES devices (id) ON DELETE CASCADE, -- NULL = cả phòng
  type              TEXT NOT NULL CHECK (type IN ('start_recording', 'stop_recording', 'switch_camera')),
  payload           TEXT,                                 -- JSON
  client_command_id TEXT NOT NULL,                        -- chống lệnh trùng (mã 1010)
  execute_at        INTEGER NOT NULL,                     -- thời điểm các máy cùng thực hiện
  created_at        INTEGER NOT NULL,
  UNIQUE (room_id, client_command_id)
);

CREATE TABLE IF NOT EXISTS command_acks (
  command_id TEXT NOT NULL REFERENCES commands (id) ON DELETE CASCADE,
  device_id  TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  status     TEXT NOT NULL CHECK (status IN ('done', 'failed')),
  acked_at   INTEGER NOT NULL,
  PRIMARY KEY (command_id, device_id)
);

-- ===== D. Upload và E. Thư viện video (tuần 4–5) =====
CREATE TABLE IF NOT EXISTS videos (
  id                   TEXT PRIMARY KEY,                  -- vd_xxx
  owner_user_id        TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id            TEXT REFERENCES devices (id) ON DELETE SET NULL,
  room_id              TEXT REFERENCES rooms (id) ON DELETE SET NULL,
  recording_session_id TEXT REFERENCES recording_sessions (id) ON DELETE SET NULL,
  local_video_uid      TEXT NOT NULL,
  file_name            TEXT NOT NULL,
  mime_type            TEXT NOT NULL DEFAULT 'video/mp4',
  size_bytes           INTEGER NOT NULL,
  duration_ms          INTEGER,
  checksum_sha256      TEXT NOT NULL,
  storage_path         TEXT NOT NULL,
  thumbnail_path       TEXT,
  recorded_at          INTEGER,
  created_at           INTEGER NOT NULL,
  UNIQUE (local_video_uid, checksum_sha256)
);
CREATE INDEX IF NOT EXISTS ix_videos_created ON videos (created_at DESC);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id              TEXT PRIMARY KEY,                       -- up_xxx
  user_id         TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  local_video_uid TEXT NOT NULL,
  file_name       TEXT NOT NULL,
  total_size      INTEGER NOT NULL,
  chunk_size      INTEGER NOT NULL,
  total_chunks    INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('uploading', 'completed', 'aborted')),
  video_id        TEXT REFERENCES videos (id) ON DELETE SET NULL,
  expires_at      INTEGER NOT NULL,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS upload_chunks (
  upload_id       TEXT NOT NULL REFERENCES upload_sessions (id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  size_bytes      INTEGER NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  received_at     INTEGER NOT NULL,
  PRIMARY KEY (upload_id, chunk_index)
);
