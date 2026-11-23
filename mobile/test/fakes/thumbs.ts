import fs from 'node:fs';
import path from 'node:path';
import { root } from './fs.ts';

export async function getThumbnailAsync(uri: string) {
  if (!fs.existsSync(uri.replace('file://', ''))) throw new Error('video chưa tồn tại');
  const p = path.join(root, `t${Math.random()}.jpg`);
  fs.writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(400, 7)]));
  return { uri: 'file://' + p };
}
