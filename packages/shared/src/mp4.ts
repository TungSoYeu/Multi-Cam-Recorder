/**
 * Nhận diện và chuẩn hóa container MP4 / QuickTime (MOV).
 *
 * iPhone (AVFoundation) ghi file QuickTime với hộp `ftyp` major brand `qt  `. Khi codec là H.264 + AAC,
 * cấu trúc hộp của MOV và MP4 (ISO BMFF) gần như trùng nhau. Vì vậy chỉ cần đổi brand trong hộp `ftyp`
 * (cùng độ dài, ghi đè tại chỗ, không nén lại hình) là trình phát MP4 đọc được. Server vẫn nên remux
 * bằng ffmpeg khi nhận file (tuần 4) để chắc chắn.
 */

const ascii = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;

export interface Ftyp {
  size: number;
  majorBrand: string;
  minorVersion: number;
  compatibleBrands: string[];
}

/** Đọc hộp `ftyp` ở đầu file. Trả null nếu không có. */
export function parseFtyp(head: Uint8Array): Ftyp | null {
  if (head.length < 16 || ascii(head, 4) !== 'ftyp') return null;
  const size = u32(head, 0);
  if (size < 16 || size > 256 || size % 4 !== 0 || size > head.length) return null;
  const compatibleBrands: string[] = [];
  for (let at = 16; at + 4 <= size; at += 4) compatibleBrands.push(ascii(head, at));
  return { size, majorBrand: ascii(head, 8), minorVersion: u32(head, 12), compatibleBrands };
}

const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'dash', 'M4V ', 'MSNV']);

export type Container = 'mp4' | 'mov' | 'unknown';

export function detectContainer(head: Uint8Array): Container {
  const f = parseFtyp(head);
  if (!f) return 'unknown';
  if (f.majorBrand === 'qt  ') return 'mov';
  if (MP4_BRANDS.has(f.majorBrand)) return 'mp4';
  return 'unknown';
}

const enc = (s: string) => [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];

/**
 * Trả về bản sao các byte đầu file với hộp `ftyp` đã đổi sang brand MP4 (cùng độ dài).
 * Trả null nếu không cần hoặc không thể đổi (đã là MP4, hoặc không có ftyp).
 */
export function patchFtypToMp4(head: Uint8Array): Uint8Array | null {
  const f = parseFtyp(head);
  if (!f || f.majorBrand !== 'qt  ') return null;
  const out = head.slice(0, f.size);
  out.set(enc('mp42'), 8);
  out.set([0, 0, 0, 0], 12);
  let first = true;
  for (let at = 16; at + 4 <= f.size; at += 4) {
    if (ascii(out, at) === 'qt  ') {
      out.set(enc(first ? 'isom' : 'mp42'), at);
      first = false;
    }
  }
  return out;
}
