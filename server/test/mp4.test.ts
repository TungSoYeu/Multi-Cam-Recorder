import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectContainer, parseFtyp, patchFtypToMp4 } from '../../packages/shared/src/mp4.ts';

function box(type: string, ...brands: string[]) {
  const size = 16 + brands.length * 4;
  const b = new Uint8Array(size + 8);
  new DataView(b.buffer).setUint32(0, size);
  b.set(Buffer.from('ftyp'), 4);
  b.set(Buffer.from(type), 8);
  new DataView(b.buffer).setUint32(12, 0x20140200);
  brands.forEach((x, i) => b.set(Buffer.from(x), 16 + i * 4));
  b.set(Buffer.from('wide'), size + 4); // dữ liệu sau ftyp giữ nguyên
  return b;
}

test('nhận diện MOV (iPhone) và MP4 (Android)', () => {
  assert.equal(detectContainer(box('qt  ', 'qt  ')), 'mov');
  assert.equal(detectContainer(box('isom', 'isom', 'mp42')), 'mp4');
  assert.equal(detectContainer(box('mp42', 'isom')), 'mp4');
  assert.equal(detectContainer(new Uint8Array(32)), 'unknown');
  assert.deepEqual(parseFtyp(box('qt  ', 'qt  '))?.compatibleBrands, ['qt  ']);
});

test('đổi ftyp QuickTime sang MP4, giữ nguyên độ dài và phần còn lại', () => {
  const mov = box('qt  ', 'qt  ', 'qt  ');
  const patched = patchFtypToMp4(mov)!;
  assert.equal(patched.length, 24);
  const f = parseFtyp(patched)!;
  assert.equal(f.majorBrand, 'mp42');
  assert.equal(f.minorVersion, 0);
  assert.deepEqual(f.compatibleBrands, ['isom', 'mp42']);
  assert.equal(detectContainer(patched), 'mp4');
  // Không đụng tới byte sau hộp ftyp
  const merged = new Uint8Array(mov);
  merged.set(patched, 0);
  assert.equal(Buffer.from(merged.slice(28, 32)).toString(), 'wide');
});

test('không đổi file đã là MP4 hoặc không có ftyp', () => {
  assert.equal(patchFtypToMp4(box('isom', 'isom')), null);
  assert.equal(patchFtypToMp4(new Uint8Array(64)), null);
  const broken = box('qt  ', 'qt  ');
  new DataView(broken.buffer).setUint32(0, 9999);
  assert.equal(patchFtypToMp4(broken), null);
});
