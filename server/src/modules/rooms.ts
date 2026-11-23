import type { FastifyInstance } from 'fastify';
import { authenticate, iso, requireRole, type Auth, type Ctx } from '../context.ts';
import { tx } from '../db/database.ts';
import { Codes, fail, ok } from '../lib/errors.ts';
import { newId, newInviteCode } from '../lib/security.ts';
import * as v from '../lib/validate.ts';
import { INVITE_CODE_RE } from '../../../packages/shared/src/validation.ts';
import { closeOwnerRooms } from './auth.ts';

interface RoomRow {
  id: string;
  owner_id: string;
  name: string;
  invite_code: string;
  invite_expires_at: number;
  max_members: number;
  status: 'open' | 'closed';
  created_at: number;
}

interface MemberRow {
  id: string;
  user_id: string;
  device_id: string;
  camera_name: string;
  joined_at: number;
  device_name: string;
  device_type: 1 | 2 | 4;
  last_seen_at: number | null;
  camera_facing: 'front' | 'back' | null;
  is_recording: number | null;
  battery_level: number | null;
  free_storage_bytes: number | null;
  resolution: string | null;
  fps: number | null;
  uploads_pending: number | null;
  upload_progress: number | null;
  live_uploaded_bytes: number | null;
  state_updated_at: number | null;
}

export function getRoom(ctx: Ctx, id: string): RoomRow {
  const r = ctx.db.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
  return r ?? fail(Codes.PARAM_VALUE_INVALID, 'Room not found', { field: 'room_id' });
}

/** Danh sách máy đang trong phòng, kèm trạng thái mới nhất do sync_device gửi lên. */
export function members(ctx: Ctx, roomId: string) {
  const rows = ctx.db
    .prepare(
      `SELECT m.id, m.user_id, m.device_id, m.camera_name, m.joined_at, d.device_name, d.device_type, d.last_seen_at,
              s.camera_facing, s.is_recording, s.battery_level, s.free_storage_bytes, s.resolution, s.fps, s.uploads_pending, s.upload_progress, s.live_uploaded_bytes,
              s.updated_at AS state_updated_at
       FROM room_members m
       JOIN devices d ON d.id = m.device_id
       LEFT JOIN device_states s ON s.device_id = m.device_id
       WHERE m.room_id = ? AND m.left_at IS NULL ORDER BY m.joined_at`,
    )
    .all(roomId) as unknown as MemberRow[];
  const onlineSince = ctx.now() - ctx.config.onlineWindowSec * 1000;
  return rows.map((m) => ({
    member_id: m.id,
    user_id: m.user_id,
    device_id: m.device_id,
    camera_name: m.camera_name,
    device_name: m.device_name,
    device_type: m.device_type,
    is_online: m.last_seen_at && m.last_seen_at >= onlineSince ? ('1' as const) : ('0' as const),
    joined_at: iso(m.joined_at),
    last_seen_at: m.last_seen_at ? iso(m.last_seen_at) : null,
    state:
      m.state_updated_at === null
        ? null
        : {
            camera_facing: m.camera_facing ?? 'back',
            is_recording: m.is_recording ? ('1' as const) : ('0' as const),
            battery_level: m.battery_level,
            free_storage_bytes: m.free_storage_bytes,
            resolution: m.resolution,
            fps: m.fps,
            uploads_pending: m.uploads_pending ?? 0,
            upload_progress: m.upload_progress,
            live_uploaded_bytes: m.live_uploaded_bytes,
            updated_at: iso(m.state_updated_at),
          },
  }));
}

const roomPayload = (ctx: Ctx, r: RoomRow) => ({
  room_id: r.id,
  room_name: r.name,
  invite_code: r.invite_code,
  max_members: r.max_members,
  expires_at: iso(r.invite_expires_at),
  created_at: iso(r.created_at),
  members: members(ctx, r.id),
});

/** Sinh mã mời chưa trùng với phòng đang mở nào. */
function uniqueInviteCode(ctx: Ctx): string {
  for (let i = 0; i < 20; i++) {
    const code = newInviteCode();
    if (!ctx.db.prepare(`SELECT 1 FROM rooms WHERE invite_code = ? AND status = 'open'`).get(code)) return code;
  }
  return fail(Codes.EXCEPTION, 'Cannot allocate invite code');
}

const defaultRoomName = (ms: number) => {
  const d = new Date(ms);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `Buổi quay ${dd}/${mm}`;
};

function assertOwner(auth: Auth, room: RoomRow) {
  requireRole(auth, 'controller');
  if (room.owner_id !== auth.user.id) fail(Codes.NOT_ROOM_OWNER);
}

export function roomRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, config } = ctx;

  // 10. create_room — chỉ Controller; đã có phòng mở thì trả lại phòng cũ
  app.post('/rooms', async (req) => {
    const auth = authenticate(ctx, req);
    requireRole(auth, 'controller');
    const b = v.asBody(req.body);
    const name = v.optStr(b, 'room_name', { max: 50 });
    const maxMembers = v.optInt(b, 'max_members', 1, 20) ?? config.defaultMaxMembers;
    const room = tx(db, () => {
      const now = ctx.now();
      const open = db.prepare(`SELECT * FROM rooms WHERE owner_id = ? AND status = 'open'`).get(auth.user.id) as
        RoomRow | undefined;
      if (open) {
        if (open.invite_expires_at <= now) {
          // Mã cũ hết hạn: cấp mã mới, giữ nguyên phòng và thành viên.
          open.invite_code = uniqueInviteCode(ctx);
          open.invite_expires_at = now + config.inviteTtlSec * 1000;
          db.prepare('UPDATE rooms SET invite_code = ?, invite_expires_at = ? WHERE id = ?').run(
            open.invite_code,
            open.invite_expires_at,
            open.id,
          );
        }
        return open;
      }
      const r: RoomRow = {
        id: newId('rm', 8),
        owner_id: auth.user.id,
        name: name ?? defaultRoomName(now),
        invite_code: uniqueInviteCode(ctx),
        invite_expires_at: now + config.inviteTtlSec * 1000,
        max_members: maxMembers,
        status: 'open',
        created_at: now,
      };
      db.prepare(
        `INSERT INTO rooms (id, owner_id, name, invite_code, invite_expires_at, max_members, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
      ).run(r.id, r.owner_id, r.name, r.invite_code, r.invite_expires_at, r.max_members, r.created_at);
      return r;
    });
    return ok(roomPayload(ctx, room));
  });

  // 11. join_room — Remote nhập mã mời và BẮT BUỘC cấp quyền điều khiển quay
  app.post('/rooms/join', async (req) => {
    const auth = authenticate(ctx, req);
    requireRole(auth, 'remote');
    const b = v.asBody(req.body);
    const raw = v.str(b, 'invite_code', { min: 6, max: 6 }).toUpperCase();
    if (!INVITE_CODE_RE.test(raw)) fail(Codes.PARAM_VALUE_INVALID, 'Invalid invite_code', { field: 'invite_code' });
    const deviceId = v.str(b, 'device_id', { max: 100 });
    const cameraName = v.str(b, 'camera_name', { max: 30 });
    if (!v.bool(b, 'grant_control'))
      fail(Codes.PARAM_VALUE_INVALID, 'Control permission must be granted', { field: 'grant_control' });
    if (!auth.device || auth.device.id !== deviceId)
      fail(Codes.PARAM_VALUE_INVALID, 'device_id does not match this session', { field: 'device_id' });

    const result = tx(db, () => {
      const now = ctx.now();
      const room = db
        .prepare(`SELECT * FROM rooms WHERE invite_code = ? AND status = 'open' AND invite_expires_at > ?`)
        .get(raw, now) as RoomRow | undefined;
      if (!room) return fail(Codes.INVITE_CODE_INVALID);
      const active = db
        .prepare('SELECT id, room_id FROM room_members WHERE device_id = ? AND left_at IS NULL')
        .get(deviceId) as { id: string; room_id: string } | undefined;
      if (active && active.room_id !== room.id)
        return fail(Codes.DEVICE_IN_ANOTHER_ROOM, undefined, { room_id: active.room_id });
      let memberId = active?.id;
      if (memberId) {
        db.prepare('UPDATE room_members SET camera_name = ? WHERE id = ?').run(cameraName, memberId);
      } else {
        const count = (
          db.prepare('SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND left_at IS NULL').get(room.id) as {
            n: number;
          }
        ).n;
        if (count >= room.max_members) return fail(Codes.ROOM_FULL);
        memberId = newId('mb', 8);
        db.prepare(
          `INSERT INTO room_members (id, room_id, device_id, user_id, camera_name, control_granted, joined_at)
           VALUES (?, ?, ?, ?, ?, 1, ?)`,
        ).run(memberId, room.id, deviceId, auth.user.id, cameraName, now);
      }
      db.prepare('UPDATE devices SET camera_name = ? WHERE id = ?').run(cameraName, deviceId);
      return { room, memberId };
    });
    return ok({
      room_id: result.room.id,
      room_name: result.room.name,
      member_id: result.memberId,
      members: members(ctx, result.room.id),
    });
  });

  // 12. get_room_members — chủ phòng hoặc thành viên đang ở trong phòng
  app.get<{ Params: { room_id: string } }>('/rooms/:room_id/members', async (req) => {
    const auth = authenticate(ctx, req);
    const room = getRoom(ctx, req.params.room_id);
    if (room.status === 'closed') fail(Codes.ROOM_CLOSED);
    if (auth.user.role === 'controller') {
      if (room.owner_id !== auth.user.id) fail(Codes.NOT_ROOM_OWNER);
    } else {
      const m = auth.device
        ? (db
            .prepare(
              'SELECT left_at, left_reason FROM room_members WHERE room_id = ? AND device_id = ? ORDER BY (left_at IS NULL) DESC, joined_at DESC, rowid DESC LIMIT 1',
            )
            .get(room.id, auth.device.id) as { left_at: number | null; left_reason: string | null } | undefined)
        : undefined;
      if (!m || m.left_at)
        fail(Codes.NOT_ACCESS, 'Device is not in this room', { reason: m?.left_reason ?? 'not_member' });
    }
    const list = members(ctx, room.id);
    if (!list.length) fail(Codes.NO_DATA, 'Room has no device'); // 9994: phòng chưa có máy nào
    return ok({ room_id: room.id, room_name: room.name, status: room.status, total: list.length, members: list });
  });

  // 13. kick_member — Controller loại một máy Remote khỏi phòng
  app.delete<{ Params: { room_id: string; member_id: string } }>('/rooms/:room_id/members/:member_id', async (req) => {
    const auth = authenticate(ctx, req);
    const room = getRoom(ctx, req.params.room_id);
    assertOwner(auth, room);
    if (room.status === 'closed') fail(Codes.ROOM_CLOSED);
    const r = db
      .prepare(
        `UPDATE room_members SET left_at = ?, left_reason = 'kicked' WHERE id = ? AND room_id = ? AND left_at IS NULL`,
      )
      .run(ctx.now(), req.params.member_id, room.id);
    if (r.changes === 0) fail(Codes.PARAM_VALUE_INVALID, 'Member not found', { field: 'member_id' });
    return ok(null);
  });

  // 14. leave_room — Remote rời phòng; Controller rời = đóng phòng. Gọi lặp lại vô hại.
  app.post<{ Params: { room_id: string } }>('/rooms/:room_id/leave', async (req) => {
    const auth = authenticate(ctx, req);
    const room = getRoom(ctx, req.params.room_id);
    if (auth.user.role === 'controller') {
      if (room.owner_id !== auth.user.id) fail(Codes.NOT_ROOM_OWNER);
      tx(db, () => closeOwnerRooms(ctx, auth.user.id));
      return ok(null);
    }
    if (auth.device)
      db.prepare(
        `UPDATE room_members SET left_at = ?, left_reason = 'left' WHERE room_id = ? AND device_id = ? AND left_at IS NULL`,
      ).run(ctx.now(), room.id, auth.device.id);
    return ok(null);
  });

  // 15. close_room — Controller đóng phòng, mọi máy Remote bị đưa ra
  app.delete<{ Params: { room_id: string } }>('/rooms/:room_id', async (req) => {
    const auth = authenticate(ctx, req);
    const room = getRoom(ctx, req.params.room_id);
    assertOwner(auth, room);
    // Đóng phòng: đưa mọi máy ra và kết thúc phiên quay đang chạy
    if (room.status === 'open') tx(db, () => closeOwnerRooms(ctx, auth.user.id));
    return ok(null);
  });
}
