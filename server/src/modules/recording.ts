import type { FastifyInstance } from 'fastify';
import { authenticate, iso, requireRole, type Auth, type Ctx } from '../context.ts';
import { tx } from '../db/database.ts';
import { ApiError, Codes, fail, ok } from '../lib/errors.ts';
import { newId } from '../lib/security.ts';
import * as v from '../lib/validate.ts';
import { getRoom } from './rooms.ts';

/** Lệnh Start hẹn trước 2,5 giây để mọi máy (poll 1 giây/lần qua 3G/4G) kịp nhận rồi cùng bắt đầu. */
export const START_LEAD_MS = 2500;
/** Lệnh Stop hẹn trước 1,5 giây. */
export const STOP_LEAD_MS = 1500;
/** Lệnh quá hạn này sẽ không giao nữa (máy đến muộn tự khớp theo trạng thái phòng). */
export const COMMAND_TTL_MS = 30_000;

export type CommandType = 'start_recording' | 'stop_recording' | 'switch_camera';

interface SessionRow {
  id: string;
  room_id: string;
  status: 'recording' | 'stopped';
  started_at: number;
  stopped_at: number | null;
}

interface CommandRow {
  id: string;
  room_id: string;
  target_device_id: string | null;
  type: CommandType;
  payload: string | null;
  client_command_id: string;
  execute_at: number;
  created_at: number;
}

export function activeSession(ctx: Ctx, roomId: string): SessionRow | undefined {
  return ctx.db.prepare(`SELECT * FROM recording_sessions WHERE room_id = ? AND status = 'recording'`).get(roomId) as SessionRow | undefined;
}

/**
 * Phiên quay để gửi cho các máy: đang quay, hoặc đã có lệnh dừng nhưng chưa tới giờ hẹn dừng.
 * Nhờ vậy máy lỡ lệnh vẫn dừng đúng giờ hẹn thay vì dừng sớm.
 */
export function syncSession(ctx: Ctx, roomId: string): SessionRow | undefined {
  return ctx.db
    .prepare(
      `SELECT * FROM recording_sessions WHERE room_id = ? AND (status = 'recording' OR stopped_at > ?)
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(roomId, ctx.now()) as SessionRow | undefined;
}

/** Trạng thái quay của phòng. started_at = giờ hẹn bắt đầu; stop_at = giờ hẹn dừng (null nếu chưa dừng). */
export function recordingPayload(s: SessionRow | undefined) {
  return s
    ? {
        recording_session_id: s.id,
        status: s.status,
        started_at: iso(s.started_at),
        started_at_ms: s.started_at,
        stop_at: s.stopped_at ? iso(s.stopped_at) : null,
        stop_at_ms: s.stopped_at,
      }
    : null;
}

/** Dừng phiên quay đang chạy (khi đóng phòng / Controller đăng xuất). */
export function endRecording(ctx: Ctx, roomId: string) {
  ctx.db
    .prepare(`UPDATE recording_sessions SET status = 'stopped', stopped_at = ? WHERE room_id = ? AND status = 'recording'`)
    .run(ctx.now(), roomId);
}

const commandPayload = (c: CommandRow) => {
  const payload = c.payload ? (JSON.parse(c.payload) as Record<string, unknown>) : {};
  return {
    command_id: c.id,
    type: c.type,
    target_device_id: c.target_device_id,
    execute_at: iso(c.execute_at),
    execute_at_ms: c.execute_at,
    created_at: iso(c.created_at),
    ...payload,
  };
};

/** Lệnh chưa ACK dành cho thiết bị (lệnh chung của phòng hoặc lệnh riêng), tạo sau khi thiết bị vào phòng. */
export function pendingCommands(ctx: Ctx, roomId: string, deviceId: string, joinedAt: number) {
  const rows = ctx.db
    .prepare(
      `SELECT c.* FROM commands c
       WHERE c.room_id = ? AND (c.target_device_id IS NULL OR c.target_device_id = ?)
         AND c.created_at >= ? AND c.created_at > ?
         AND NOT EXISTS (SELECT 1 FROM command_acks a WHERE a.command_id = c.id AND a.device_id = ?)
       ORDER BY c.created_at, c.rowid`,
    )
    .all(roomId, deviceId, joinedAt, ctx.now() - COMMAND_TTL_MS, deviceId) as unknown as CommandRow[];
  return rows.map(commandPayload);
}

/** Ghi ACK từ thiết bị. Bỏ qua ACK cho lệnh không thuộc phòng của thiết bị. */
export function saveAcks(ctx: Ctx, roomId: string, deviceId: string, raw: unknown) {
  if (raw === undefined || raw === null) return;
  if (!Array.isArray(raw)) fail(Codes.PARAM_TYPE_INVALID, 'acks must be an array', { field: 'acks' });
  const acks = raw as unknown[];
  if (acks.length > 50) fail(Codes.PARAM_VALUE_INVALID, 'Too many acks', { field: 'acks' });
  const stmt = ctx.db.prepare(
    `INSERT INTO command_acks (command_id, device_id, status, acked_at)
     SELECT id, ?, ?, ? FROM commands WHERE id = ? AND room_id = ?
     ON CONFLICT (command_id, device_id) DO NOTHING`,
  );
  for (const a of acks) {
    const b = v.asBody(a);
    const id = v.str(b, 'command_id', { max: 40 });
    const status = v.str(b, 'status', { max: 10 });
    if (status !== 'done' && status !== 'failed') fail(Codes.PARAM_VALUE_INVALID, 'Invalid ack status', { field: 'acks' });
    stmt.run(deviceId, status, ctx.now(), id, roomId);
  }
}

/** Trạng thái lệnh gần nhất mà mỗi thiết bị phải thực hiện: pending | done | failed. */
export function lastCommandStatus(ctx: Ctx, roomId: string, member: { device_id: string; joined_at_ms: number }) {
  const c = ctx.db
    .prepare(
      `SELECT c.id, c.type, a.status FROM commands c
       LEFT JOIN command_acks a ON a.command_id = c.id AND a.device_id = ?
       WHERE c.room_id = ? AND (c.target_device_id IS NULL OR c.target_device_id = ?) AND c.created_at >= ?
       ORDER BY c.created_at DESC, c.rowid DESC LIMIT 1`,
    )
    .get(member.device_id, roomId, member.device_id, member.joined_at_ms) as { id: string; type: CommandType; status: string | null } | undefined;
  return c ? { command_id: c.id, type: c.type, status: (c.status ?? 'pending') as 'pending' | 'done' | 'failed' } : null;
}

function ownerRoom(ctx: Ctx, auth: Auth, roomId: string) {
  requireRole(auth, 'controller');
  const room = getRoom(ctx, roomId);
  if (room.owner_id !== auth.user.id) fail(Codes.NOT_ROOM_OWNER);
  if (room.status === 'closed') fail(Codes.ROOM_CLOSED);
  return room;
}

/** Lệnh trùng client_command_id → 1010 kèm kết quả lần trước (client coi như thành công). */
function duplicate(ctx: Ctx, roomId: string, clientCommandId: string) {
  const c = ctx.db.prepare('SELECT * FROM commands WHERE room_id = ? AND client_command_id = ?').get(roomId, clientCommandId) as
    | CommandRow
    | undefined;
  if (!c) return;
  const payload = c.payload ? (JSON.parse(c.payload) as { recording_session_id?: string }) : {};
  throw new ApiError(Codes.ACTION_DONE_PREVIOUSLY, undefined, {
    command_id: c.id,
    type: c.type,
    recording_session_id: payload.recording_session_id ?? null,
    execute_at: iso(c.execute_at),
    execute_at_ms: c.execute_at,
  });
}

function insertCommand(ctx: Ctx, c: Omit<CommandRow, 'id' | 'created_at'>) {
  const id = newId('cmd', 10);
  ctx.db
    .prepare(
      `INSERT INTO commands (id, room_id, target_device_id, type, payload, client_command_id, execute_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, c.room_id, c.target_device_id, c.type, c.payload, c.client_command_id, c.execute_at, ctx.now());
  return id;
}

const activeMemberCount = (ctx: Ctx, roomId: string) =>
  (ctx.db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND left_at IS NULL').get(roomId) as { n: number }).n;

export function recordingRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // 18. start_recording — Controller ra lệnh mọi máy trong phòng cùng bắt đầu quay
  app.post<{ Params: { room_id: string } }>('/rooms/:room_id/recording/start', async (req) => {
    const auth = authenticate(ctx, req);
    const b = v.asBody(req.body);
    const clientCommandId = v.str(b, 'client_command_id', { max: 64 });
    const room = ownerRoom(ctx, auth, req.params.room_id);
    const result = tx(db, () => {
      duplicate(ctx, room.id, clientCommandId);
      if (activeSession(ctx, room.id)) fail(Codes.INVALID_SESSION_STATE, 'Room is already recording');
      const total = activeMemberCount(ctx, room.id);
      if (total === 0) fail(Codes.NO_DATA, 'Room has no device');
      const executeAt = ctx.now() + START_LEAD_MS;
      const sessionId = newId('rs', 10);
      db.prepare(`INSERT INTO recording_sessions (id, room_id, status, started_at) VALUES (?, ?, 'recording', ?)`).run(
        sessionId,
        room.id,
        executeAt,
      );
      const commandId = insertCommand(ctx, {
        room_id: room.id,
        target_device_id: null,
        type: 'start_recording',
        payload: JSON.stringify({ recording_session_id: sessionId }),
        client_command_id: clientCommandId,
        execute_at: executeAt,
      });
      return { sessionId, commandId, executeAt, total };
    });
    return ok({
      recording_session_id: result.sessionId,
      command_id: result.commandId,
      status: 'recording',
      execute_at: iso(result.executeAt),
      execute_at_ms: result.executeAt,
      server_time_ms: ctx.now(),
      total_devices: result.total,
    });
  });

  // 19. stop_recording — Controller ra lệnh mọi máy cùng dừng
  app.post<{ Params: { room_id: string } }>('/rooms/:room_id/recording/stop', async (req) => {
    const auth = authenticate(ctx, req);
    const b = v.asBody(req.body);
    const clientCommandId = v.str(b, 'client_command_id', { max: 64 });
    const room = ownerRoom(ctx, auth, req.params.room_id);
    const result = tx(db, () => {
      duplicate(ctx, room.id, clientCommandId);
      const s = activeSession(ctx, room.id) ?? fail(Codes.INVALID_SESSION_STATE, 'Room is not recording');
      const executeAt = Math.max(ctx.now() + STOP_LEAD_MS, s.started_at + 1000);
      db.prepare(`UPDATE recording_sessions SET status = 'stopped', stopped_at = ? WHERE id = ?`).run(executeAt, s.id);
      const commandId = insertCommand(ctx, {
        room_id: room.id,
        target_device_id: null,
        type: 'stop_recording',
        payload: JSON.stringify({ recording_session_id: s.id }),
        client_command_id: clientCommandId,
        execute_at: executeAt,
      });
      return { sessionId: s.id, commandId, executeAt, startedAt: s.started_at };
    });
    return ok({
      recording_session_id: result.sessionId,
      command_id: result.commandId,
      status: 'stopped',
      execute_at: iso(result.executeAt),
      execute_at_ms: result.executeAt,
      server_time_ms: ctx.now(),
      duration_ms: result.executeAt - result.startedAt,
    });
  });

  // Mở rộng: Controller đổi camera trước/sau của một máy Remote (đề bài: "Controller điều khiển được việc này")
  app.post<{ Params: { room_id: string; member_id: string } }>('/rooms/:room_id/members/:member_id/camera', async (req) => {
    const auth = authenticate(ctx, req);
    const b = v.asBody(req.body);
    const clientCommandId = v.str(b, 'client_command_id', { max: 64 });
    const facing = v.str(b, 'camera_facing', { max: 5 });
    if (facing !== 'front' && facing !== 'back') fail(Codes.PARAM_VALUE_INVALID, 'Invalid camera_facing', { field: 'camera_facing' });
    const room = ownerRoom(ctx, auth, req.params.room_id);
    const result = tx(db, () => {
      duplicate(ctx, room.id, clientCommandId);
      const m = db
        .prepare('SELECT device_id FROM room_members WHERE id = ? AND room_id = ? AND left_at IS NULL')
        .get(req.params.member_id, room.id) as { device_id: string } | undefined;
      if (!m) fail(Codes.PARAM_VALUE_INVALID, 'Member not found', { field: 'member_id' });
      if (activeSession(ctx, room.id)) fail(Codes.INVALID_SESSION_STATE, 'Cannot switch camera while recording');
      const executeAt = ctx.now();
      const commandId = insertCommand(ctx, {
        room_id: room.id,
        target_device_id: m!.device_id,
        type: 'switch_camera',
        payload: JSON.stringify({ camera_facing: facing }),
        client_command_id: clientCommandId,
        execute_at: executeAt,
      });
      return { commandId, executeAt };
    });
    return ok({ command_id: result.commandId, camera_facing: facing, execute_at: iso(result.executeAt), execute_at_ms: result.executeAt });
  });
}
