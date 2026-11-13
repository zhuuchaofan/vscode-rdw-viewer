/** 测试辅助：构造带前后 RDW 的记录文件 */
export function rec(body: Uint8Array | number[], opts: { front?: number; back?: number } = {}): Buffer {
  const b = Buffer.from(body);
  const head = Buffer.alloc(4);
  const tail = Buffer.alloc(4);
  head.writeUInt16LE(opts.front ?? b.length, 0);
  tail.writeUInt16LE(opts.back ?? b.length, 0);
  return Buffer.concat([head, b, tail]);
}

export const ascii = (s: string): Buffer => Buffer.from(s, 'latin1');
export const hexBytes = (s: string): Buffer => Buffer.from(s.replace(/\s+/g, ''), 'hex');
