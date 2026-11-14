/**
 * RDW（Record Descriptor Word）可变长记录扫描。
 *
 * 记录结构： [前置RDW 4B][正文 N 字节][后置RDW 4B]
 * RDW 前 2 字节为小端 uint16，表示正文长度 N；后 2 字节保留，不使用。
 *
 * 支持直接扫描内存缓冲区或流式/分页数据源（ByteSource），并用可倍增扩容的 TypedArray
 * 收集索引，避免百万级记录初始化时的普通 JS 数组内存峰值。
 * 本模块不依赖 VS Code，便于单元测试。
 */
import { t } from './i18n';
import { ByteSource, toByteSource } from './source';

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

export interface ScanProgress {
  /** 返回 true 时中止扫描 */
  isCancelled?: () => boolean;
  /** 进度（0~1） */
  onProgress?: (fraction: number) => void;
  /** 连续占用事件循环的最长时间（毫秒）；省略时为 30 */
  sliceMs?: number;
}

export const RDW_SIZE = 4;
/** 一条记录最少 8 字节（两个 RDW，正文为 0） */
const MIN_RECORD = RDW_SIZE * 2;
/** 出错后向后重新寻找记录边界的最大范围 */
const RESYNC_LIMIT = 1 << 20;
/** 每处理这么多条记录交回一次控制权（由调用方检查时间片、取消、报告进度） */
const SCAN_CHECK_RECORDS = 1 << 14;
/**
 * 重新对齐（逐字节寻找记录边界）时，每检查这么多字节交回一次控制权。
 * 正常记录每条只读两个长度字段，耗时与记录大小无关；而损坏区域要逐字节检查，
 * 一次重新对齐最多 1MB，只按记录条数计数的话，损坏较多的大文件会长时间无法取消。
 */
const RESYNC_CHECK_BYTES = 1 << 16;
const DEFAULT_SLICE_MS = 30;

const hex = (n: number): string => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

/**
 * 动态扩容的 TypedArray 索引构建器：
 * 直接在连续 TypedArray 上追加，避免百万条记录时先建 3 个大型 JS Number[] 再转换的双倍以上峰值内存。
 */
class IndexBuilder {
  count = 0;
  private cap: number;
  private offsets: Float64Array;
  private lengths: Uint32Array;
  private isError: Uint8Array;
  readonly errors = new Map<number, string>();

  constructor(initialCap = 256) {
    this.cap = Math.max(16, initialCap);
    this.offsets = new Float64Array(this.cap);
    this.lengths = new Uint32Array(this.cap);
    this.isError = new Uint8Array(this.cap);
  }

  private grow(): void {
    const nextCap = this.cap * 2;
    const o = new Float64Array(nextCap);
    o.set(this.offsets);
    this.offsets = o;
    const l = new Uint32Array(nextCap);
    l.set(this.lengths);
    this.lengths = l;
    const e = new Uint8Array(nextCap);
    e.set(this.isError);
    this.isError = e;
    this.cap = nextCap;
  }

  pushOk(off: number, len: number): void {
    if (this.count === this.cap) {
      this.grow();
    }
    const i = this.count++;
    this.offsets[i] = off;
    this.lengths[i] = len;
    this.isError[i] = 0;
  }

  pushError(off: number, skipped: number, msg: string): void {
    if (this.count === this.cap) {
      this.grow();
    }
    const i = this.count++;
    this.errors.set(i, msg);
    this.offsets[i] = off;
    this.lengths[i] = skipped;
    this.isError[i] = 1;
  }

  finish(size: number): RdwIndex {
    const n = this.count;
    // 若剩余预分配空间超过实际用量的 25% 且较大，则收缩到精确长度释放多余内存
    const shrink = this.cap - n > 1024 && n * 4 < this.cap * 3;
    return {
      size,
      count: n,
      offsets: shrink ? this.offsets.slice(0, n) : this.offsets.subarray(0, n),
      lengths: shrink ? this.lengths.slice(0, n) : this.lengths.subarray(0, n),
      isError: shrink ? this.isError.slice(0, n) : this.isError.subarray(0, n),
      errors: this.errors,
    };
  }
}

/** 读取 pos 处的小端 uint16 */
function u16At(src: ByteSource, raw: Uint8Array | undefined, pos: number): number {
  if (raw) {
    return raw[pos] | (raw[pos + 1] << 8);
  }
  if (src.u16le) {
    return src.u16le(pos);
  }
  const b = src.read(pos, 2);
  return b[0] | (b[1] << 8);
}

/** 若 pos 处是前后 RDW 自洽的记录，返回下一条记录的起始偏移，否则返回 -1 */
function validAt(src: ByteSource, raw: Uint8Array | undefined, size: number, pos: number): number {
  if (pos + MIN_RECORD > size) {
    return -1;
  }
  const len = u16At(src, raw, pos);
  const end = pos + RDW_SIZE + len;
  if (end + RDW_SIZE > size) {
    return -1;
  }
  if (u16At(src, raw, end) !== len) {
    return -1;
  }
  return end + RDW_SIZE;
}

/** pos 处是被截断的文件末尾：剩余不足一条记录，或前置 RDW 声明的长度超出文件末尾 */
function truncatedTailAt(src: ByteSource, raw: Uint8Array | undefined, size: number, pos: number): boolean {
  const remain = size - pos;
  if (remain < MIN_RECORD) {
    return remain > 0;
  }
  return pos + RDW_SIZE + u16At(src, raw, pos) + RDW_SIZE > size;
}

/**
 * pos 处记录有效（前后 RDW 一致、长度不为 0），并且其后紧跟文件末尾、另一条有效记录，或被截断的文件末尾。
 * 最后一种情况用于在「坏记录之后紧接着文件被截断」时，仍能找回中间的正常记录。
 */
function chainValidAt(src: ByteSource, raw: Uint8Array | undefined, size: number, pos: number): boolean {
  // 长度为 0 的「记录」不作为重新对齐的锚点：RDW 的后 2 字节多为 00 00，
  // 连续的 0 字节很容易看起来像一条前后一致的空记录
  if (pos + RDW_SIZE <= size && u16At(src, raw, pos) === 0) {
    return false;
  }
  const next = validAt(src, raw, size, pos);
  if (next < 0) {
    return false;
  }
  return next === size || validAt(src, raw, size, next) >= 0 || truncatedTailAt(src, raw, size, next);
}

/**
 * 分批扫描生成器：供同步 scanRdw 与异步可取消 scanRdwAsync 共用同一套逻辑。
 */
function* scanGenerator(input: Uint8Array | ByteSource): Generator<number, RdwIndex> {
  const src = toByteSource(input);
  const raw = src.raw;
  const size = src.size;
  const est = size === 0 ? 16 : Math.min(1 << 20, Math.max(64, Math.ceil(size / 128)));
  const builder = new IndexBuilder(est);

  /**
   * 从 pos 之后逐字节寻找下一个可信的记录边界。
   * 返回新位置；找不到则返回 size 并把剩余部分都算作错误。
   */
  const resync = function* (pos: number, msg: string): Generator<number, number> {
    const limit = Math.min(size - MIN_RECORD, pos + RESYNC_LIMIT);
    // 热循环放在普通函数里（生成器函数本身优化得较差）：返回找到的位置，没有则返回 -1
    const search = (from: number, to: number): number => {
      for (let q = from; q <= to; q++) {
        if (chainValidAt(src, raw, size, q)) {
          return q;
        }
      }
      return -1;
    };
    for (let from = pos + 1; from <= limit; from += RESYNC_CHECK_BYTES) {
      const q = search(from, Math.min(limit, from + RESYNC_CHECK_BYTES - 1));
      if (q >= 0) {
        builder.pushError(pos, q - pos, t('rdw.resynced', { msg, n: q - pos, off: hex(q) }));
        return q;
      }
      yield from / size;
    }
    builder.pushError(pos, size - pos, t('rdw.noResync', { msg, n: size - pos }));
    return size;
  };

  let pos = 0;
  let steps = 0;
  while (pos < size) {
    if ((++steps & (SCAN_CHECK_RECORDS - 1)) === 0) {
      yield pos / size;
    }
    const remain = size - pos;
    if (remain < MIN_RECORD) {
      builder.pushError(
        pos,
        remain,
        t('rdw.tailShort', { off: hex(pos), remain, min: MIN_RECORD })
      );
      break;
    }
    const len = u16At(src, raw, pos);
    const end = pos + RDW_SIZE + len;

    if (end + RDW_SIZE > size) {
      pos = yield* resync(
        pos,
        t('rdw.truncated', { off: hex(pos), len, need: RDW_SIZE + len + RDW_SIZE, remain })
      );
      continue;
    }

    const trailing = u16At(src, raw, end);
    if (trailing !== len) {
      const msg = t('rdw.mismatch', { off: hex(pos), len, endOff: hex(end), trailing });
      const next = end + RDW_SIZE;
      if (next === size || validAt(src, raw, size, next) >= 0) {
        // 记录边界本身可信（下一条记录正常），把这一条整体标为错误
        builder.pushError(pos, next - pos, msg);
        pos = next;
      } else {
        pos = yield* resync(pos, msg);
      }
      continue;
    }

    builder.pushOk(pos, len);
    pos = end + RDW_SIZE;
  }

  return builder.finish(size);
}

export function scanRdw(input: Uint8Array | ByteSource): RdwIndex {
  const it = scanGenerator(input);
  let r = it.next();
  while (!r.done) {
    r = it.next();
  }
  return r.value;
}

/**
 * 异步扫描 RDW 记录边界，定期交回事件循环报告进度并支持中途取消（供超大文件打开时使用）。
 * 若取消则返回 undefined。
 */
export async function scanRdwAsync(
  input: Uint8Array | ByteSource,
  opts: ScanProgress = {}
): Promise<RdwIndex | undefined> {
  // 开始前已经取消（例如编辑器在打开途中被关闭）时不做任何读取
  if (opts.isCancelled?.()) {
    return undefined;
  }
  const it = scanGenerator(input);
  let last = performance.now();
  let r = it.next();
  while (!r.done) {
    if (performance.now() - last >= (opts.sliceMs ?? DEFAULT_SLICE_MS)) {
      opts.onProgress?.(r.value);
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (opts.isCancelled?.()) {
        return undefined;
      }
      last = performance.now();
    }
    r = it.next();
  }
  return r.value;
}
