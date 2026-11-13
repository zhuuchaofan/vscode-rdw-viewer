/**
 * RDW（Record Descriptor Word）可变长记录扫描。
 *
 * 记录结构： [前置RDW 4B][正文 N 字节][后置RDW 4B]
 * RDW 前 2 字节为小端 uint16，表示正文长度 N；后 2 字节保留，不使用。
 *
 * 本模块不依赖 VS Code，便于单元测试。
 */
import { t } from './i18n';

export interface RdwIndex {
  /** 文件总字节数 */
  size: number;
  /** 条目总数（含错误条目） */
  count: number;
  /** 条目起始偏移（正常记录=前置RDW位置；错误条目=出错位置） */
  offsets: Float64Array;
  /** 正常记录=正文长度；错误条目=被跳过的字节数 */
  lengths: Uint32Array;
  /** 1=错误条目 */
  isError: Uint8Array;
  /** 错误条目的原因说明 */
  errors: Map<number, string>;
}

export const RDW_SIZE = 4;
/** 一条记录最少 8 字节（两个 RDW，正文为 0） */
const MIN_RECORD = RDW_SIZE * 2;
/** 出错后向后重新寻找记录边界的最大范围 */
const RESYNC_LIMIT = 1 << 20;

const hex = (n: number): string => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

/** 若 pos 处是前后 RDW 自洽的记录，返回下一条记录的起始偏移，否则返回 -1 */
function validAt(buf: Uint8Array, view: DataView, pos: number): number {
  if (pos + MIN_RECORD > buf.length) {
    return -1;
  }
  const len = view.getUint16(pos, true);
  const end = pos + RDW_SIZE + len;
  if (end + RDW_SIZE > buf.length) {
    return -1;
  }
  if (view.getUint16(end, true) !== len) {
    return -1;
  }
  return end + RDW_SIZE;
}

/** pos 处是被截断的文件末尾：剩余不足一条记录，或前置 RDW 声明的长度超出文件末尾 */
function truncatedTailAt(buf: Uint8Array, view: DataView, pos: number): boolean {
  const remain = buf.length - pos;
  if (remain < MIN_RECORD) {
    return remain > 0;
  }
  return pos + RDW_SIZE + view.getUint16(pos, true) + RDW_SIZE > buf.length;
}

/**
 * pos 处记录有效（前后 RDW 一致、长度不为 0），并且其后紧跟文件末尾、另一条有效记录，或被截断的文件末尾。
 * 最后一种情况用于在「坏记录之后紧接着文件被截断」时，仍能找回中间的正常记录。
 */
function chainValidAt(buf: Uint8Array, view: DataView, pos: number): boolean {
  // 长度为 0 的「记录」不作为重新对齐的锚点：RDW 的后 2 字节多为 00 00，
  // 连续的 0 字节很容易看起来像一条前后一致的空记录
  if (pos + RDW_SIZE <= buf.length && view.getUint16(pos, true) === 0) {
    return false;
  }
  const next = validAt(buf, view, pos);
  if (next < 0) {
    return false;
  }
  return next === buf.length || validAt(buf, view, next) >= 0 || truncatedTailAt(buf, view, next);
}

export function scanRdw(buf: Uint8Array): RdwIndex {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const size = buf.length;
  const offsets: number[] = [];
  const lengths: number[] = [];
  const isError: number[] = [];
  const errors = new Map<number, string>();

  const pushOk = (off: number, len: number) => {
    offsets.push(off);
    lengths.push(len);
    isError.push(0);
  };
  const pushError = (off: number, skipped: number, msg: string) => {
    errors.set(offsets.length, msg);
    offsets.push(off);
    lengths.push(skipped);
    isError.push(1);
  };

  /**
   * 从 pos 之后逐字节寻找下一个可信的记录边界。
   * 返回新位置；找不到则返回 size 并把剩余部分都算作错误。
   */
  const resync = (pos: number, msg: string): number => {
    const limit = Math.min(size - MIN_RECORD, pos + RESYNC_LIMIT);
    for (let q = pos + 1; q <= limit; q++) {
      if (chainValidAt(buf, view, q)) {
        pushError(pos, q - pos, t('rdw.resynced', { msg, n: q - pos, off: hex(q) }));
        return q;
      }
    }
    pushError(pos, size - pos, t('rdw.noResync', { msg, n: size - pos }));
    return size;
  };

  let pos = 0;
  while (pos < size) {
    const remain = size - pos;
    if (remain < MIN_RECORD) {
      pushError(
        pos,
        remain,
        t('rdw.tailShort', { off: hex(pos), remain, min: MIN_RECORD })
      );
      break;
    }
    const len = view.getUint16(pos, true);
    const end = pos + RDW_SIZE + len;

    if (end + RDW_SIZE > size) {
      pos = resync(
        pos,
        t('rdw.truncated', { off: hex(pos), len, need: RDW_SIZE + len + RDW_SIZE, remain })
      );
      continue;
    }

    const trailing = view.getUint16(end, true);
    if (trailing !== len) {
      const msg = t('rdw.mismatch', { off: hex(pos), len, endOff: hex(end), trailing });
      const next = end + RDW_SIZE;
      if (next === size || validAt(buf, view, next) >= 0) {
        // 记录边界本身可信（下一条记录正常），把这一条整体标为错误
        pushError(pos, next - pos, msg);
        pos = next;
      } else {
        pos = resync(pos, msg);
      }
      continue;
    }

    pushOk(pos, len);
    pos = end + RDW_SIZE;
  }

  return {
    size,
    count: offsets.length,
    offsets: Float64Array.from(offsets),
    lengths: Uint32Array.from(lengths),
    isError: Uint8Array.from(isError),
    errors,
  };
}
