/**
 * 两个 RDW 文件的比较：按记录序号或键项目对应记录，逐字段比较。
 * 不依赖 VS Code，便于测试。
 *
 * - 记录序号：A 的第 n 条正常记录对应 B 的第 n 条（RDW 错误条目不参与比较）。
 * - 键项目：按指定位置的字节（可多个，拼接后比较）对应记录；同一键出现多次时按出现顺序配对。
 *   显示顺序以 A 为准，只在 B 中的记录插入到它在 B 中前后记录的附近。
 */
import { CellInfo, DumpInfo, InitPayload, RdwSession, RecRow } from './session';
import { Column } from './layout';

export type MatchMode = 'index' | 'key';

/** 键项目：正文中的位置（从 1 开始）和长度 */
export interface KeyPart {
  start: number;
  length: number;
}

/** same=相同、chg=有差异、a=只在 A、b=只在 B */
export type PairStatus = 'same' | 'chg' | 'a' | 'b';
const STATUS: PairStatus[] = ['same', 'chg', 'a', 'b'];
const ST_SAME = 0;
const ST_CHG = 1;
const ST_A = 2;
const ST_B = 3;

export interface CompareStats {
  pairs: number;
  same: number;
  chg: number;
  a: number;
  b: number;
  /** 键项目超出记录长度、无法取得键的记录数 */
  noKeyA: number;
  noKeyB: number;
}

export interface PairRow {
  t: 'pair';
  /** 配对序号 */
  p: number;
  st: PairStatus;
  a: RecRow | null;
  b: RecRow | null;
  /** 有差异的列下标（各自分组中的列下标） */
  da: number[];
  db: number[];
}

/** 分组组合切换处插入的表头行（k=0..2：项目名 / 属性 / 相对位置） */
export interface PairHdr {
  t: 'hdr';
  ga: string | null;
  gb: string | null;
  k: number;
}

export type CompareRow = PairRow | PairHdr;

export interface CompareInit {
  type: 'cinit';
  a: InitPayload;
  b: InitPayload;
  mode: MatchMode;
  keys: KeyPart[];
  stats: CompareStats;
  /** 全部显示 / 只显示差异 时的行数 */
  count: number;
  diffCount: number;
  /** 分组组合有多个时，表头随行插入；只有一个时使用固定表头 */
  inline: boolean;
  combos: Array<{ ga: string | null; gb: string | null }>;
}

function sameBytes(x: Uint8Array, y: Uint8Array): boolean {
  return x.length === y.length && sameRange(x, 0, y, 0, x.length);
}

/** x[xo..xo+len) 与 y[yo..yo+len) 相同（不创建子数组，逐条比较大量记录时避免分配） */
function sameRange(x: Uint8Array, xo: number, y: Uint8Array, yo: number, len: number): boolean {
  for (let i = 0; i < len; i++) {
    if (x[xo + i] !== y[yo + i]) {
      return false;
    }
  }
  return true;
}

/** 比较结果（算完后一次性替换，中途取消时保留原来的结果） */
interface CompareState {
  mode: MatchMode;
  keys: KeyPart[];
  pa: Int32Array;
  pb: Int32Array;
  st: Uint8Array;
  stats: CompareStats;
  comboOf: Int32Array;
  combos: Array<{ ga: string | null; gb: string | null }>;
  all: Int32Array;
  diff: Int32Array;
  inline: boolean;
}

export interface CompareProgress {
  /** 返回 true 时中止，比较结果保持不变 */
  isCancelled?: () => boolean;
  /** 进度（0~1） */
  onProgress?: (fraction: number) => void;
  /** 连续占用事件循环的最长时间（毫秒）；省略时为 30 */
  sliceMs?: number;
}

/** 每处理这么多条记录交回一次控制权（检查取消、报告进度） */
const CHUNK = 1 << 14;
/** 异步比较时，连续占用事件循环的最长时间（毫秒）的默认值 */
const SLICE_MS = 30;

/** 两组列的位置、长度、名称完全相同（同一 copybook 布局） */
export function sameShape(x: Column[], y: Column[]): boolean {
  return (
    x.length === y.length &&
    x.every((c, i) => c.start === y[i].start && c.len === y[i].len && c.name === y[i].name && c.kind === y[i].kind)
  );
}

/** 布局不同时，按名称（同名时按出现顺序）找对应的列；找不到时返回 -1 */
export function counterpartColumn(from: Column[], i: number, to: Column[]): number {
  if (sameShape(from, to)) {
    return i;
  }
  const name = from[i]?.name;
  if (name === undefined) {
    return -1;
  }
  let nth = 0;
  for (let k = 0; k < i; k++) {
    if (from[k].name === name) nth++;
  }
  for (let k = 0; k < to.length; k++) {
    if (to[k].name === name && nth-- === 0) {
      return k;
    }
  }
  return -1;
}

export function keyLabel(keys: KeyPart[]): string {
  return keys.map((k) => `${k.start}~${k.start + k.length - 1}`).join(' + ');
}

export class CompareSession {
  private pa: Int32Array = new Int32Array(0);
  private pb: Int32Array = new Int32Array(0);
  private st: Uint8Array = new Uint8Array(0);
  private comboOf: Int32Array = new Int32Array(0);
  private combos: Array<{ ga: string | null; gb: string | null }> = [];
  private all: Int32Array = new Int32Array(0);
  private diff: Int32Array = new Int32Array(0);
  private inline = false;
  private stats: CompareStats = { pairs: 0, same: 0, chg: 0, a: 0, b: 0, noKeyA: 0, noKeyB: 0 };
  mode: MatchMode = 'index';
  keys: KeyPart[] = [];

  /** compute=false 时不立即比较（之后由调用方执行 configureAsync，大文件时可以取消） */
  constructor(
    readonly a: RdwSession,
    readonly b: RdwSession,
    compute = true
  ) {
    if (compute) {
      this.configure('index', []);
    }
  }

  /** 设置对应方式并重新比较（同步；大文件请用 configureAsync） */
  configure(mode: MatchMode, keys: KeyPart[]): void {
    const it = this.compute(mode, keys);
    let r = it.next();
    while (!r.done) {
      r = it.next();
    }
    this.commit(r.value);
  }

  /**
   * 设置对应方式并重新比较，中途定期交回事件循环，可以取消。
   * 返回 false 表示已取消，此时比较结果保持原样。
   */
  async configureAsync(mode: MatchMode, keys: KeyPart[], opts: CompareProgress = {}): Promise<boolean> {
    const it = this.compute(mode, keys);
    let last = performance.now();
    let r = it.next();
    while (!r.done) {
      if (performance.now() - last >= (opts.sliceMs ?? SLICE_MS)) {
        opts.onProgress?.(r.value);
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (opts.isCancelled?.()) {
          return false;
        }
        last = performance.now();
      }
      r = it.next();
    }
    this.commit(r.value);
    return true;
  }

  private commit(s: CompareState): void {
    this.mode = s.mode;
    this.keys = s.keys;
    this.pa = s.pa;
    this.pb = s.pb;
    this.st = s.st;
    this.stats = s.stats;
    this.comboOf = s.comboOf;
    this.combos = s.combos;
    this.all = s.all;
    this.diff = s.diff;
    this.inline = s.inline;
  }

  /** 比较的主体：每处理一批记录 yield 一次进度（0~1），结束时返回结果 */
  private *compute(reqMode: MatchMode, reqKeys: KeyPart[]): Generator<number, CompareState> {
    const mode: MatchMode = reqMode === 'key' && reqKeys.length > 0 ? 'key' : 'index';
    const keys = mode === 'key' ? reqKeys.map((k) => ({ ...k })) : [];
    const A = this.a;
    const B = this.b;
    const bufA = A.raw;
    const bufB = B.raw;
    // 内存模式下直接用整块 Buffer.compare（原生 memcmp）；分页大文件模式下按需分页读取并用原生 Buffer.compare 比较
    const nodeA = bufA ? Buffer.from(bufA.buffer, bufA.byteOffset, bufA.byteLength) : undefined;
    const nodeB = bufB ? Buffer.from(bufB.buffer, bufB.byteOffset, bufB.byteLength) : undefined;
    const ra = A.recordEntries();
    const rb = B.recordEntries();
    const na = ra.length;
    const nb = rb.length;
    let pa: Int32Array;
    let pb: Int32Array;
    let noKeyA = 0;
    let noKeyB = 0;

    if (mode === 'index') {
      const n = Math.max(na, nb);
      pa = new Int32Array(n).fill(-1);
      pb = new Int32Array(n).fill(-1);
      pa.set(ra);
      pb.set(rb);
    } else {
      // 键直接按字节做哈希和比较（开放定址哈希表），不为每条记录生成字符串。
      // 分页文件模式下，把每条记录紧凑拼接后的键字节存进连续 Uint8Array（keysB），
      // 避免哈希冲突回表时触发随机磁盘页淘汰。
      const keyEnd = Math.max(...keys.map((k) => k.start - 1 + k.length));
      const keyTotalLen = keys.reduce((sum, k) => sum + k.length, 0);

      const hashRaw = (buf: Uint8Array, base: number): number => {
        let h = 0x811c9dc5;
        for (const part of keys) {
          const from = base + part.start - 1;
          for (let i = from; i < from + part.length; i++) {
            h = Math.imul(h ^ buf[i], 0x01000193);
          }
        }
        return h >>> 0;
      };
      const hashSource = (s: RdwSession, base: number, dst?: Uint8Array, dstOff = 0): number => {
        let h = 0x811c9dc5;
        let w = dstOff;
        for (const part of keys) {
          const slice = s.source.read(base + part.start - 1, part.length);
          if (dst) {
            dst.set(slice, w);
            w += part.length;
          }
          for (let i = 0; i < slice.length; i++) {
            h = Math.imul(h ^ slice[i], 0x01000193);
          }
        }
        return h >>> 0;
      };

      const keysB = bufB ? undefined : new Uint8Array(nb * keyTotalLen);
      const keyScratchA = bufA && bufB ? undefined : new Uint8Array(keyTotalLen);

      const sameKeyBB = (j1: number, b1: number, j2: number, b2: number): boolean => {
        if (bufB) {
          return keys.every((part) => sameRange(bufB, b1 + part.start - 1, bufB, b2 + part.start - 1, part.length));
        }
        return sameRange(keysB!, j1 * keyTotalLen, keysB!, j2 * keyTotalLen, keyTotalLen);
      };
      const sameKeyAB = (baseA: number, jB: number, baseB: number): boolean => {
        if (bufA && bufB) {
          return keys.every((part) => sameRange(bufA, baseA + part.start - 1, bufB, baseB + part.start - 1, part.length));
        }
        if (keysB) {
          return sameRange(keyScratchA!, 0, keysB, jB * keyTotalLen, keyTotalLen);
        }
        // A 为分页文件、B 为内存缓冲区
        let w = 0;
        for (const part of keys) {
          if (!sameRange(keyScratchA!, w, bufB!, baseB + part.start - 1, part.length)) {
            return false;
          }
          w += part.length;
        }
        return true;
      };

      let cap = 16;
      while (cap < nb * 2) {
        cap *= 2;
      }
      const mask = cap - 1;
      // table：槽 → 该键在 B 中最早出现、尚未配对的下标 + 1（0 = 空）；next：同一键的下一次出现
      const table = new Int32Array(cap);
      const next = new Int32Array(nb).fill(-1);
      // 倒序插入，使每个键的链表按出现顺序排列
      // 热循环放在普通函数里（生成器函数本身优化得较差），生成器只负责分批调用
      const insertB = (j: number): void => {
        const e = rb[j];
        if (keyEnd > B.bodyLength(e)) {
          noKeyB++;
          return;
        }
        const base = B.bodyOffset(e);
        const h = bufB ? hashRaw(bufB, base) : hashSource(B, base, keysB, j * keyTotalLen);
        let slot = h & mask;
        for (;;) {
          const head = table[slot];
          if (head === 0) {
            table[slot] = j + 1;
            break;
          }
          const hj = head - 1;
          if (sameKeyBB(j, base, hj, B.bodyOffset(rb[hj]))) {
            next[j] = hj;
            table[slot] = j + 1;
            break;
          }
          slot = (slot + 1) & mask;
        }
      };
      for (let hi = nb; hi > 0; hi -= CHUNK) {
        for (let j = hi - 1, lo = Math.max(0, hi - CHUNK); j >= lo; j--) {
          insertB(j);
        }
        yield 0.25 * (1 - hi / nb);
      }

      const matchOfA = new Int32Array(na).fill(-1);
      const matchedB = new Uint8Array(nb);
      let matched = 0;
      const matchA = (i: number): void => {
        const e = ra[i];
        if (keyEnd > A.bodyLength(e)) {
          noKeyA++;
          return;
        }
        const base = A.bodyOffset(e);
        let h: number;
        if (bufA && bufB) {
          h = hashRaw(bufA, base);
        } else if (bufA) {
          h = hashRaw(bufA, base);
          let w = 0;
          for (const part of keys) {
            const from = base + part.start - 1;
            keyScratchA!.set(bufA.subarray(from, from + part.length), w);
            w += part.length;
          }
        } else {
          h = hashSource(A, base, keyScratchA, 0);
        }
        let slot = h & mask;
        for (;;) {
          const head = table[slot];
          if (head === 0) {
            break;
          }
          if (head > 0 && sameKeyAB(base, head - 1, B.bodyOffset(rb[head - 1]))) {
            const j = head - 1;
            matchOfA[i] = j;
            matchedB[j] = 1;
            matched++;
            // 同一键的下一次出现顶上来；用完后留下墓碑（-1），以免打断探测
            table[slot] = next[j] >= 0 ? next[j] + 1 : -1;
            break;
          }
          slot = (slot + 1) & mask;
        }
      };
      for (let lo = 0; lo < na; lo += CHUNK) {
        for (let i = lo, hi = Math.min(na, lo + CHUNK); i < hi; i++) {
          matchA(i);
        }
        yield 0.25 + 0.25 * (lo / na);
      }

      // 以 A 的顺序为准；只在 B 中的记录在经过它在 B 中的位置时插入
      const n = na + nb - matched;
      pa = new Int32Array(n);
      pb = new Int32Array(n);
      let p = 0;
      let cur = 0;
      const flushB = (upto: number) => {
        for (; cur < upto; cur++) {
          if (!matchedB[cur]) {
            pa[p] = -1;
            pb[p++] = rb[cur];
          }
        }
      };
      for (let i = 0; i < na; i++) {
        const j = matchOfA[i];
        if (j >= 0 && j >= cur) {
          flushB(j);
          cur = j + 1;
        }
        pa[p] = ra[i];
        pb[p++] = j >= 0 ? rb[j] : -1;
      }
      flushB(nb);
    }

    const n = pa.length;
    const st = new Uint8Array(n);
    const stats: CompareStats = { pairs: n, same: 0, chg: 0, a: 0, b: 0, noKeyA, noKeyB };
    const done = mode === 'key' ? 0.5 : 0;
    const status = (p: number): void => {
      const ea = pa[p];
      const eb = pb[p];
      let s: number;
      if (ea < 0) {
        s = ST_B;
        stats.b++;
      } else if (eb < 0) {
        s = ST_A;
        stats.a++;
      } else {
        const len = A.bodyLength(ea);
        let eq = len === B.bodyLength(eb);
        if (eq && len > 0) {
          if (nodeA && nodeB) {
            const oa = A.bodyOffset(ea);
            const ob = B.bodyOffset(eb);
            eq = nodeA.compare(nodeB, ob, ob + len, oa, oa + len) === 0;
          } else {
            const ba = A.body(ea);
            const bb = B.body(eb);
            eq = Buffer.from(ba.buffer, ba.byteOffset, ba.byteLength).compare(
              Buffer.from(bb.buffer, bb.byteOffset, bb.byteLength)
            ) === 0;
          }
        }
        if (eq) {
          s = ST_SAME;
          stats.same++;
        } else {
          s = ST_CHG;
          stats.chg++;
        }
      }
      st[p] = s;
    };
    for (let lo = 0; lo < n; lo += CHUNK) {
      for (let p = lo, hi = Math.min(n, lo + CHUNK); p < hi; p++) {
        status(p);
      }
      yield done + (0.9 - done) * (lo / n);
    }

    // 分组组合（缺失的一侧沿用上一条的分组；开头缺失时用该侧第一条记录的分组）及显示行
    const combos: Array<{ ga: string | null; gb: string | null }> = [];
    const comboIdx = new Map<string, number>();
    const comboOf = new Int32Array(n);
    const firstA = pa.find((e) => e >= 0);
    const firstB = pb.find((e) => e >= 0);
    let lastA: string | null = firstA !== undefined ? A.groupOfEntry(firstA)?.key ?? null : null;
    let lastB: string | null = firstB !== undefined ? B.groupOfEntry(firstB)?.key ?? null : null;
    let prevA: string | null | undefined;
    let prevB: string | null | undefined;
    let ci = 0;
    const combo = (p: number): void => {
      if (pa[p] >= 0) lastA = A.groupOfEntry(pa[p])?.key ?? null;
      if (pb[p] >= 0) lastB = B.groupOfEntry(pb[p])?.key ?? null;
      if (lastA !== prevA || lastB !== prevB) {
        // 组合和上一条不同时才查表（绝大多数记录与上一条相同）
        const key = `${lastA}\u0001${lastB}`;
        let found = comboIdx.get(key);
        if (found === undefined) {
          found = combos.length;
          comboIdx.set(key, found);
          combos.push({ ga: lastA, gb: lastB });
        }
        ci = found;
        prevA = lastA;
        prevB = lastB;
      }
      comboOf[p] = ci;
    };
    for (let lo = 0; lo < n; lo += CHUNK) {
      for (let p = lo, hi = Math.min(n, lo + CHUNK); p < hi; p++) {
        combo(p);
      }
      yield 0.9 + 0.05 * (lo / n);
    }
    const inline = combos.length > 1;
    const build = (onlyDiff: boolean): Int32Array => {
      let rows = 0;
      let last = -1;
      // 先数行数再填，避免中间数组
      for (let pass = 0; pass < 2; pass++) {
        const out = pass === 1 ? new Int32Array(rows) : undefined;
        rows = 0;
        last = -1;
        for (let p = 0; p < n; p++) {
          if (onlyDiff && st[p] === ST_SAME) {
            continue;
          }
          const c = comboOf[p];
          if (inline && c !== last) {
            for (let k = 0; k < 3; k++) {
              if (out) out[rows] = -1 - (c * 3 + k);
              rows++;
            }
            last = c;
          }
          if (out) out[rows] = p;
          rows++;
        }
        if (out) {
          return out;
        }
      }
      return new Int32Array(0);
    };
    yield 0.95;
    const all = build(false);
    yield 0.98;
    const diff = build(true);
    return { mode, keys, pa, pb, st, stats, comboOf, combos, all, diff, inline };
  }

  getStats(): CompareStats {
    return { ...this.stats };
  }

  /** 配对：A / B 的条目序号（缺失为 -1）和状态 */
  pair(p: number): { a: number; b: number; st: PairStatus } {
    return { a: this.pa[p], b: this.pb[p], st: STATUS[this.st[p]] };
  }

  init(): CompareInit {
    return {
      type: 'cinit',
      a: this.a.init(),
      b: this.b.init(),
      mode: this.mode,
      keys: this.keys,
      stats: this.getStats(),
      count: this.all.length,
      diffCount: this.diff.length,
      inline: this.inline,
      combos: this.combos,
    };
  }

  private list(onlyDiff: boolean): Int32Array {
    return onlyDiff ? this.diff : this.all;
  }

  count(onlyDiff: boolean): number {
    return this.list(onlyDiff).length;
  }

  /** 有差异的列（各自分组中的列下标） */
  diffColumns(ea: number, eb: number): { da: number[]; db: number[] } {
    const ga = this.a.groupOfEntry(ea);
    const gb = this.b.groupOfEntry(eb);
    const da: number[] = [];
    const db: number[] = [];
    if (!ga || !gb) {
      return { da, db };
    }
    if (sameShape(ga.columns, gb.columns)) {
      ga.columns.forEach((col, i) => {
        if (!sameBytes(this.a.slice(ea, col), this.b.slice(eb, gb.columns[i]))) {
          da.push(i);
          db.push(i);
        }
      });
      return { da, db };
    }
    // 布局不同：按名称对应，比较显示文字
    const usedB = new Set<number>();
    ga.columns.forEach((col, i) => {
      const j = counterpartColumn(ga.columns, i, gb.columns);
      if (j < 0) {
        da.push(i);
        return;
      }
      usedB.add(j);
      if (this.a.cell(ea, col).text !== this.b.cell(eb, gb.columns[j]).text) {
        da.push(i);
        db.push(j);
      }
    });
    gb.columns.forEach((_, j) => !usedB.has(j) && db.push(j));
    db.sort((x, y) => x - y);
    return { da, db };
  }

  private pairRow(p: number): PairRow {
    const ea = this.pa[p];
    const eb = this.pb[p];
    const st = this.st[p];
    const d = st === ST_CHG ? this.diffColumns(ea, eb) : { da: [], db: [] };
    return {
      t: 'pair',
      p,
      st: STATUS[st],
      a: ea >= 0 ? (this.a.entryRow(ea) as RecRow) : null,
      b: eb >= 0 ? (this.b.entryRow(eb) as RecRow) : null,
      da: d.da,
      db: d.db,
    };
  }

  getRows(onlyDiff: boolean, start: number, count: number): CompareRow[] {
    const list = this.list(onlyDiff);
    const rows: CompareRow[] = [];
    for (let i = Math.max(0, start); i < Math.min(list.length, start + count); i++) {
      const v = list[i];
      if (v >= 0) {
        rows.push(this.pairRow(v));
      } else {
        const code = -1 - v;
        const c = this.combos[Math.floor(code / 3)];
        rows.push({ t: 'hdr', ga: c.ga, gb: c.gb, k: code % 3 });
      }
    }
    return rows;
  }

  /** 从显示行 from 开始向 dir 方向找下一处差异（不含 from 本身）；没有时返回 -1 */
  findDiff(onlyDiff: boolean, from: number, dir: 1 | -1): number {
    const list = this.list(onlyDiff);
    for (let i = from + dir; i >= 0 && i < list.length; i += dir) {
      const v = list[i];
      if (v >= 0 && this.st[v] !== ST_SAME) {
        return i;
      }
    }
    return -1;
  }

  /** 单元格信息：side 一侧的 col 列，以及另一侧对应的列 */
  cellPair(p: number, side: 'a' | 'b', col: number): { a: CellInfo | null; b: CellInfo | null; ca: number; cb: number } {
    const ea = this.pa[p];
    const eb = this.pb[p];
    const ga = ea >= 0 ? this.a.groupOfEntry(ea) : undefined;
    const gb = eb >= 0 ? this.b.groupOfEntry(eb) : undefined;
    let ca = side === 'a' ? col : -1;
    let cb = side === 'b' ? col : -1;
    if (ga && gb) {
      if (side === 'a') cb = counterpartColumn(ga.columns, col, gb.columns);
      else ca = counterpartColumn(gb.columns, col, ga.columns);
    }
    return {
      a: ga && ca >= 0 ? this.a.cellInfo(ga.key, ea, ca) ?? null : null,
      b: gb && cb >= 0 ? this.b.cellInfo(gb.key, eb, cb) ?? null : null,
      ca: ga ? ca : -1,
      cb: gb ? cb : -1,
    };
  }

  dumpPair(p: number): { a: DumpInfo | null; b: DumpInfo | null } {
    const ea = this.pa[p];
    const eb = this.pb[p];
    return {
      a: ea >= 0 ? this.a.recordDump(ea) ?? null : null,
      b: eb >= 0 ? this.b.recordDump(eb) ?? null : null,
    };
  }
}
