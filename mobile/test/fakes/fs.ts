import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-mobile-'));
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Part = string | { p: string };
const join = (parts: Part[]) => path.join(...parts.map((x) => (typeof x === 'string' ? x.replace(/^file:\/\//, '') : x.p)));

export const FileMode = { ReadWrite: 'rw', ReadOnly: 'r' } as const;

class Handle {
  offset: number | null = 0;
  fd: number;
  constructor(p: string, mode: string) {
    this.fd = fs.openSync(p, mode === 'rw' ? 'r+' : 'r');
  }
  readBytesSync(n: number) {
    const b = Buffer.alloc(n);
    const k = fs.readSync(this.fd, b, 0, n, this.offset!);
    this.offset! += k;
    return new Uint8Array(b.subarray(0, k));
  }
  async readBytes(n: number) {
    await delay(1);
    return this.readBytesSync(n);
  }
  writeBytesSync(b: Uint8Array) {
    fs.writeSync(this.fd, b, 0, b.length, this.offset!);
    this.offset! += b.length;
  }
  close() {
    fs.closeSync(this.fd);
  }
}

export class File {
  p: string;
  constructor(...parts: Part[]) {
    this.p = join(parts);
  }
  get uri() {
    return 'file://' + this.p;
  }
  get name() {
    return path.basename(this.p);
  }
  get exists() {
    return fs.existsSync(this.p);
  }
  get size() {
    return this.exists ? fs.statSync(this.p).size : null;
  }
  create() {
    fs.writeFileSync(this.p, '');
  }
  delete() {
    fs.rmSync(this.p);
  }
  open(mode = 'rw') {
    return new Handle(this.p, mode);
  }
  // SDK 58: các hàm dưới đây BẤT ĐỒNG BỘ
  async text() {
    await delay(2);
    return fs.readFileSync(this.p, 'utf8');
  }
  async write(s: string) {
    await delay(5);
    fs.writeFileSync(this.p, s);
  }
  async base64() {
    return fs.readFileSync(this.p).toString('base64');
  }
  async move(d: File) {
    await delay(20);
    fs.renameSync(this.p, d.p);
    this.p = d.p;
  }
}

export class Directory {
  p: string;
  constructor(...parts: Part[]) {
    this.p = join(parts);
  }
  get exists() {
    return fs.existsSync(this.p);
  }
  get name() {
    return path.basename(this.p);
  }
  create() {
    fs.mkdirSync(this.p, { recursive: true });
  }
  list() {
    return fs.readdirSync(this.p).map((n) => new File(this.p, n));
  }
}

export const Paths = { document: new Directory(root, 'doc'), cache: new Directory(root, 'cache') };
