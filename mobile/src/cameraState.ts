import type { CameraFacing } from '@multicam/shared';

/** Trạng thái camera hiện tại — màn quay cập nhật, vòng sync đọc và gửi lên server. */
export const cameraState = {
  facing: 'back' as CameraFacing,
  isRecording: false,
  resolution: '1080p',
  fps: 30,
};
