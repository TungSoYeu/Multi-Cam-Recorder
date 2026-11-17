import type { FastifyInstance } from 'fastify';
import { authenticate, iso, requireRole, type Ctx } from '../context.ts';
import { Codes, fail, ok } from '../lib/errors.ts';
import * as v from '../lib/validate.ts';
import { getRoom, members } from './rooms.ts';

/** Chu kỳ client nên gọi sync (ms). */
export const SYNC_INTERVAL_MS = 2000;

export function syncRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  // 16. sync_device — máy Remote gửi trạng thái, nhận về trạng thái phòng (và lệnh)
  app.post<{ Params: { device_id: string } }>('/devices/:device_id/sync', async (req) => {
    const auth = authenticate(ctx, req);
    if (!auth.device || auth.device.id !== req.params.device_id) fail(Codes.NOT_ACCESS, 'Device does not belong to this session');
    const deviceId = auth.device!.id;
    const b = v.asBody(req.body);

    const facing = v.optStr(b, 'camera_facing', { max: 5 }) ?? 'back';
    if (facing !== 'front' && facing !== 'back') fail(Codes.PARAM_VALUE_INVALID, 'Invalid camera_facing', { field: 'camera_facing' });
    const isRecording = b.is_recording === undefined ? false : v.bool(b, 'is_recording');
    const battery = v.optInt(b, 'battery_level', -1, 100);
    const storage = v.optInt(b, 'free_storage_bytes', 0, Number.MAX_SAFE_INTEGER);
    const resolution = v.optStr(b, 'resolution', { max: 20 });
    const fps = v.optInt(b, 'fps', 1, 240);
    const now = ctx.now();

    db.prepare(
      `INSERT INTO device_states (device_id, camera_facing, is_recording, battery_level, free_storage_bytes, resolution, fps, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET
         camera_facing = excluded.camera_facing, is_recording = excluded.is_recording,
         battery_level = excluded.battery_level, free_storage_bytes = excluded.free_storage_bytes,
         resolution = excluded.resolution, fps = excluded.fps, updated_at = excluded.updated_at`,
    ).run(deviceId, facing, isRecording ? 1 : 0, battery ?? null, storage ?? null, resolution ?? null, fps ?? null, now);
    db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(now, deviceId);

    const m = db
      .prepare(
        `SELECT m.id, m.room_id, m.left_at, m.left_reason, r.name AS room_name
         FROM room_members m JOIN rooms r ON r.id = m.room_id
         WHERE m.device_id = ? ORDER BY (m.left_at IS NULL) DESC, m.joined_at DESC, m.rowid DESC LIMIT 1`,
      )
      .get(deviceId) as { id: string; room_id: string; left_at: number | null; left_reason: string | null; room_name: string } | undefined;
    const inRoom = m && !m.left_at;

    return ok({
      server_time: iso(now),
      server_time_ms: now,
      interval_ms: SYNC_INTERVAL_MS,
      room: inRoom ? { room_id: m.room_id, room_name: m.room_name, member_id: m.id } : null,
      // Lý do rời phòng gần nhất: 'kicked' | 'closed' | 'left' | 'logout' (null nếu chưa từng vào phòng)
      last_left_reason: !inRoom && m ? m.left_reason : null,
      commands: [] as unknown[],
    });
  });

  // 17. sync_room — Controller lấy toàn bộ trạng thái phòng: danh sách máy, pin, dung lượng, camera, đang quay
  app.get<{ Params: { room_id: string } }>('/rooms/:room_id/sync', async (req) => {
    const auth = authenticate(ctx, req);
    requireRole(auth, 'controller');
    const room = getRoom(ctx, req.params.room_id);
    if (room.owner_id !== auth.user.id) fail(Codes.NOT_ROOM_OWNER);
    if (room.status === 'closed') fail(Codes.ROOM_CLOSED);
    const list = members(ctx, room.id);
    const now = ctx.now();
    return ok({
      room_id: room.id,
      room_name: room.name,
      invite_code: room.invite_code,
      expires_at: iso(room.invite_expires_at),
      max_members: room.max_members,
      server_time: iso(now),
      server_time_ms: now,
      interval_ms: SYNC_INTERVAL_MS,
      total: list.length,
      online: list.filter((x) => x.is_online === '1').length,
      recording: null, // phiên quay đang chạy
      members: list,
    });
  });
}
