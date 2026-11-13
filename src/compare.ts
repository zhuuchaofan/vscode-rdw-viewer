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
  if (x.length !== y.length) {
    return false;
  }
  for (let i = 0; i < x.length; i++) {
    if (x[i] !== y[i]) {
      return false;
    }
  }
  return true;
}

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
  private pa = new Int32Array(0);
  private pb = new Int32Array(0);
  private st = new Uint8Array(0);
  private comboOf = new Int32Array(0);
  private combos: Array<{ ga: string | null; gb: string | null }> = [];
  private all: Int32Array = new Int32Array(0);
  private diff: Int32Array = new Int32Array(0);
  private inline = false;
  private stats: CompareStats = { pairs: 0, same: 0, chg: 0, a: 0, b: 0, noKeyA: 0, noKeyB: 0 };
  mode: MatchMode = 'index';
  keys: KeyPart[] = [];

  constructor(
    readonly a: RdwSession,
    readonly b: RdwSession
  ) {
    this.configure('index', []);
  }

  private keyOf(s: RdwSession, e: number, keys: KeyPart[]): string | null {
    const body = s.body(e);
    let k = '';
    for (const part of keys) {
      if (part.start - 1 + part.length > body.length) {
        return null;
      }
      for (let i = part.start - 1; i < part.start - 1 + part.length; i++) {
        k += String.fromCharCode(body[i]);
      }
      k += '\u0001';
    }
    return k;
  }

  /** 设置对应方式并重新比较 */
  configure(mode: MatchMode, keys: KeyPart[]): void {
    this.mode = mode === 'key' && keys.length > 0 ? 'key' : 'index';
    this.keys = this.mode === 'key' ? keys.map((k) => ({ ...k })) : [];
    const ra = this.a.recordEntries();
    const rb = this.b.recordEntries();
    const pa: number[] = [];
    const pb: number[] = [];
    let noKeyA = 0;
    let noKeyB = 0;

    if (this.mode === 'index') {
      for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
        pa.push(i < ra.length ? ra[i] : -1);
        pb.push(i < rb.length ? rb[i] : -1);
      }
    } else {
      // B 的键 → B 中的下标队列
      const queue = new Map<string, number[]>();
      rb.forEach((e, j) => {
        const k = this.keyOf(this.b, e, this.keys);
        if (k === null) {
          noKeyB++;
          return;
        }
        const q = queue.get(k);
        q ? q.push(j) : queue.set(k, [j]);
      });
      const matchOfA: number[] = ra.map((e) => {
        const k = this.keyOf(this.a, e, this.keys);
        if (k === null) {
          noKeyA++;
          return -1;
        }
        const q = queue.get(k);
        return q && q.length ? q.shift()! : -1;
      });
      const matchedB = new Uint8Array(rb.length);
      matchOfA.forEach((j) => j >= 0 && (matchedB[j] = 1));
      // 以 A 的顺序为准；只在 B 中的记录在经过它在 B 中的位置时插入
      let nb = 0;
      const flushB = (upto: number) => {
        for (; nb < upto; nb++) {
          if (!matchedB[nb]) {
            pa.push(-1);
            pb.push(rb[nb]);
          }
        }
      };
      ra.forEach((e, i) => {
        const j = matchOfA[i];
        if (j >= 0 && j >= nb) {
          flushB(j);
          nb = j + 1;
        }
        pa.push(e);
        pb.push(j >= 0 ? rb[j] : -1);
      });
      flushB(rb.length);
    }

    const n = pa.length;
    this.pa = Int32Array.from(pa);
    this.pb = Int32Array.from(pb);
    this.st = new Uint8Array(n);
    const stats: CompareStats = { pairs: n, same: 0, chg: 0, a: 0, b: 0, noKeyA, noKeyB };
    for (let p = 0; p < n; p++) {
      const ea = this.pa[p];
      const eb = this.pb[p];
      let s: number;
      if (ea < 0) {
        s = ST_B;
        stats.b++;
      } else if (eb < 0) {
        s = ST_A;
        stats.a++;
      } else if (sameBytes(this.a.body(ea), this.b.body(eb))) {
        s = ST_SAME;
        stats.same++;
      } else {
        s = ST_CHG;
        stats.chg++;
      }
      this.st[p] = s;
    }
    this.stats = stats;
    this.buildDisplay();
  }

  /** 分组组合（缺失的一侧沿用上一条的分组）及显示行 */
  private buildDisplay(): void {
    const n = this.pa.length;
    const comboIdx = new Map<string, number>();
    this.combos = [];
    this.comboOf = new Int32Array(n);
    // 缺失的一侧沿用上一条的分组；开头缺失时用该侧第一条记录的分组
    const firstA = this.pa.find((e) => e >= 0);
    const firstB = this.pb.find((e) => e >= 0);
    let lastA: string | null = firstA !== undefined ? this.a.groupOfEntry(firstA)?.key ?? null : null;
    let lastB: string | null = firstB !== undefined ? this.b.groupOfEntry(firstB)?.key ?? null : null;
    for (let p = 0; p < n; p++) {
      if (this.pa[p] >= 0) lastA = this.a.groupOfEntry(this.pa[p])?.key ?? null;
      if (this.pb[p] >= 0) lastB = this.b.groupOfEntry(this.pb[p])?.key ?? null;
      const key = `${lastA}\u0001${lastB}`;
      let ci = comboIdx.get(key);
      if (ci === undefined) {
        ci = this.combos.length;
        comboIdx.set(key, ci);
        this.combos.push({ ga: lastA, gb: lastB });
      }
      this.comboOf[p] = ci;
    }
    this.inline = this.combos.length > 1;
    const build = (onlyDiff: boolean): Int32Array => {
      const out: number[] = [];
      let last = -1;
      for (let p = 0; p < n; p++) {
        if (onlyDiff && this.st[p] === ST_SAME) {
          continue;
        }
        const ci = this.comboOf[p];
        if (this.inline && ci !== last) {
          for (let k = 0; k < 3; k++) out.push(-1 - (ci * 3 + k));
          last = ci;
        }
        out.push(p);
      }
      return Int32Array.from(out);
    };
    this.all = build(false);
    this.diff = build(true);
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
