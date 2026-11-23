import { FileMode, type File } from 'expo-file-system';
import * as Crypto from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex } from '@noble/hashes/utils';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SHA-256 của một mảnh — dùng hàm native nên nhanh, không làm khựng giao diện. */
export async function chunkSha256(bytes: Uint8Array): Promise<string> {
  const buf = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes as Uint8Array<ArrayBuffer>);
  return bytesToHex(new Uint8Array(buf));
}

export async function readRange(file: File, offset: number, length: number): Promise<Uint8Array> {
  const h = file.open(FileMode.ReadOnly);
  try {
    h.offset = offset;
    return await h.readBytes(length);
  } finally {
    h.close();
  }
}

const BLOCK = 256 * 1024;

/**
 * SHA-256 toàn file. Expo không có hàm băm native theo từng phần nên dùng JS, đọc khối nhỏ và
 * nhường CPU sau mỗi khối; `busy()` = true (đang quay) thì tạm chờ để không làm trễ lệnh Start/Stop.
 */
export async function fileSha256(
  file: File,
  total: number,
  opts: { busy: () => boolean; onProgress?: (p: number) => void },
): Promise<string> {
  const h = sha256.create();
  const handle = file.open(FileMode.ReadOnly);
  try {
    for (let off = 0; off < total; off += BLOCK) {
      while (opts.busy()) await sleep(500);
      handle.offset = off;
      h.update(await handle.readBytes(Math.min(BLOCK, total - off)));
      if ((off / BLOCK) % 16 === 0) opts.onProgress?.(off / total);
      await sleep(0);
    }
  } finally {
    handle.close();
  }
  return bytesToHex(h.digest());
}
