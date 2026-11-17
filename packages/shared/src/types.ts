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
  /** Số clip đang chờ / đang upload trên máy */
  uploads_pending: number;
  /** % của clip đang upload (null nếu không upload) */
  upload_progress: number | null;
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

export type CommandType = 'start_recording' | 'stop_recording' | 'switch_camera';

export interface DeviceCommand {
  command_id: string;
  type: CommandType;
  target_device_id: string | null;
  /** Thời điểm (giờ server) mọi máy cùng thực hiện */
  execute_at: string;
  execute_at_ms: number;
  created_at: string;
  recording_session_id?: string;
  camera_facing?: CameraFacing;
}

export interface CommandAck {
  command_id: string;
  status: 'done' | 'failed';
}

export interface RecordingState {
  recording_session_id: string;
  status: 'recording' | 'stopped';
  started_at: string;
  started_at_ms: number;
  /** Giờ hẹn dừng (đã có lệnh Stop nhưng chưa tới giờ), null nếu đang quay */
  stop_at: string | null;
  stop_at_ms: number | null;
}

export interface SyncDeviceRequest {
  camera_facing: CameraFacing;
  is_recording: boolean;
  battery_level?: number;
  free_storage_bytes?: number;
  resolution?: string;
  fps?: number;
  acks?: CommandAck[];
  uploads_pending?: number;
  upload_progress?: number;
}

export type LeftReason = 'kicked' | 'closed' | 'left' | 'logout';

export interface SyncDeviceData {
  server_time: string;
  server_time_ms: number;
  interval_ms: number;
  room: { room_id: string; room_name: string; member_id: string } | null;
  last_left_reason: LeftReason | null;
  /** Phòng đang quay (null nếu không) — để máy lỡ lệnh tự khớp */
  recording: RecordingState | null;
  commands: DeviceCommand[];
}

export interface CommandResult {
  command_id: string;
  recording_session_id: string;
  status: 'recording' | 'stopped';
  execute_at: string;
  execute_at_ms: number;
  server_time_ms: number;
  total_devices?: number;
  duration_ms?: number;
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
  recording: RecordingState | null;
  /** Số clip của phòng đã upload xong */
  videos_received: number;
  members: (RoomMember & {
    last_command: { command_id: string; type: CommandType; status: 'pending' | 'done' | 'failed' } | null;
  })[];
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

// ===== D — Upload theo mảnh =====

export interface InitUploadRequest {
  /** UUID của clip sinh trên máy — cùng với checksum dùng để chống upload trùng (3005) */
  local_video_uid: string;
  file_name: string;
  total_size: number;
  checksum_sha256: string;
  chunk_size?: number;
  duration_ms?: number;
  recording_session_id?: string | null;
  recorded_at_ms?: number | null;
  camera_facing?: CameraFacing;
  mime_type?: 'video/mp4' | 'video/quicktime';
}

export interface UploadStatus {
  upload_id: string;
  status: 'uploading' | 'completed' | 'aborted';
  total_size: number;
  chunk_size: number;
  total_chunks: number;
  received_count: number;
  missing_chunks: number[];
  expires_at: string;
  video_id: string | null;
}

export interface ChunkResult {
  upload_id: string;
  index: number;
  received_count: number;
  total_chunks: number;
}

export interface VideoInfo {
  video_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  checksum_sha256: string;
  room_id: string | null;
  recording_session_id: string | null;
  device_id: string | null;
  owner_user_id: string;
  has_thumbnail: '0' | '1';
  recorded_at: string | null;
  created_at: string;
}

// ===== E — Thư viện video trên server =====

export interface LibraryVideo {
  video_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  duration_ms: number | null;
  checksum_sha256: string;
  room_id: string | null;
  recording_session_id: string | null;
  /** Giờ hẹn bắt đầu của buổi quay (giờ server) */
  session_started_at: string | null;
  device_id: string | null;
  device_name: string | null;
  device_type: DeviceType | null;
  camera_name: string | null;
  owner: { user_id: string; name: string };
  /** Giờ bắt đầu quay thực tế theo giờ server — dùng để căn khớp các góc quay */
  recorded_at: string | null;
  recorded_at_ms: number | null;
  created_at: string;
  thumbnail_url: string | null;
}

export interface VideoListQuery {
  index?: number;
  count?: number;
  room_id?: string;
  recording_session_id?: string;
  device_id?: string;
}

export interface VideoList {
  videos: LibraryVideo[];
  total: number;
  index: number;
  count: number;
  has_more: '0' | '1';
}

export type VideoDetail = LibraryVideo & { stream_url: string | null; stream_expires_at: string | null };

export interface DownloadLink {
  video_id: string;
  file_name: string;
  size_bytes: number;
  download_url: string;
  expires_at: string;
}
