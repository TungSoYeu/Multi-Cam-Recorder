export type AccountRole = 'controller' | 'remote';
export type VerifyPurpose = 'signup' | 'forgot_password';
/** 1 = android, 2 = ios, 4 = web (theo đề bài login). */
export type DeviceType = 1 | 2 | 4;

export interface ApiEnvelope<T> {
  code: string;
  message: string;
  data: T;
}

/** Định danh đăng nhập: gửi email HOẶC phone. */
export type Identifier = { email: string; phone?: never } | { phone: string; email?: never };

export interface DeviceInfo {
  device_id: string;
  device_type: DeviceType;
  device_name: string;
}

export interface UserProfile {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
}

export interface SignupRequest {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  password: string;
}
export interface SignupData {
  user_id: string;
  email: string;
  phone: string;
  account_role: 'remote';
  verify_required: '1';
}

export type GetVerifyCodeRequest = Identifier & { purpose: VerifyPurpose };
export interface GetVerifyCodeData {
  expires_in: number;
  resend_after: number;
  masked_target: string;
  code_verify?: string;
}

/** device_* là tùy chọn: gửi kèm để vào thẳng Trang chính (đăng ký luôn thiết bị). */
export type CheckVerifyCodeRequest = Identifier & { code_verify: string } & Partial<DeviceInfo>;

export interface SessionDevice {
  device_id: string;
  device_type: DeviceType;
  device_name: string;
  camera_name: string;
}

export interface LoginData {
  user: UserProfile;
  account_role: AccountRole;
  access_token: string;
  refresh_token: string;
  expires_in: number;
  device: SessionDevice | null;
}
export type CheckVerifyCodeData = LoginData & { user_id: string; active: '1' };
export type LoginRequest = Identifier & { password: string } & DeviceInfo;

export interface TokenData {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export type ForgotPasswordRequest = Identifier & { code_verify: string; new_password: string };
export interface ChangePasswordRequest {
  password: string;
  new_password: string;
}

export interface MeData {
  user: UserProfile;
  account_role: AccountRole;
  device: SessionDevice | null;
  room_id: string | null;
}

export type CameraFacing = 'front' | 'back';

/** Trạng thái thiết bị do sync_device gửi lên. */
export interface DeviceState {
  camera_facing: CameraFacing;
  is_recording: '0' | '1';
  /** 0–100, -1 nếu không đọc được */
  battery_level: number | null;
  free_storage_bytes: number | null;
  resolution: string | null;
  fps: number | null;
  updated_at: string;
}

export interface RoomMember {
  member_id: string;
  user_id: string;
  device_id: string;
  camera_name: string;
  device_name: string;
  device_type: DeviceType;
  is_online: '0' | '1';
  joined_at: string;
  last_seen_at: string | null;
  state: DeviceState | null;
}

export interface SyncDeviceRequest {
  camera_facing: CameraFacing;
  is_recording: boolean;
  battery_level?: number;
  free_storage_bytes?: number;
  resolution?: string;
  fps?: number;
}

export type LeftReason = 'kicked' | 'closed' | 'left' | 'logout';

export interface SyncDeviceData {
  server_time: string;
  server_time_ms: number;
  interval_ms: number;
  room: { room_id: string; room_name: string; member_id: string } | null;
  last_left_reason: LeftReason | null;
  /** Lệnh điều khiển quay */
  commands: unknown[];
}

export interface SyncRoomData {
  room_id: string;
  room_name: string;
  invite_code: string;
  expires_at: string;
  max_members: number;
  server_time: string;
  server_time_ms: number;
  interval_ms: number;
  total: number;
  online: number;
  recording: null;
  members: RoomMember[];
}

export interface RoomData {
  room_id: string;
  room_name: string;
  invite_code: string;
  max_members: number;
  expires_at: string;
  created_at: string;
  members: RoomMember[];
}

export interface CreateRoomRequest {
  room_name?: string;
  max_members?: number | string;
}

export interface JoinRoomRequest {
  invite_code: string;
  device_id: string;
  camera_name: string;
  grant_control: true;
}
export interface JoinRoomData {
  room_id: string;
  room_name: string;
  member_id: string;
  members: RoomMember[];
}

export interface RoomMembersData {
  room_id: string;
  room_name: string;
  status: 'open';
  total: number;
  members: RoomMember[];
}
