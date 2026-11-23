import crypto from 'node:crypto';

export const randomUUID = () => crypto.randomUUID();
export const CryptoDigestAlgorithm = { SHA256: 'SHA-256' };
export const digest = async (_algo: string, data: Uint8Array) => {
  const b = crypto.createHash('sha256').update(data).digest();
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
};
