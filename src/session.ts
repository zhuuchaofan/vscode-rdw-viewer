/**
 * 一个已打开文件的数据模型：持有文件内容、RDW 索引、按长度分组的结果，
 * 并按需（虚拟滚动）解码出行数据。不依赖 VS Code，便于测试。
 */
import { RdwIndex, scanRdw, RDW_SIZE } from './rdw';
import { Copybook } from './copybook';
import { Banner, Column, MismatchMode, buildColumns, displayWidth } from './layout';
import { SUPPORTED_ENCODINGS, createDecoder, sanitize, toHex } from './decode';
import { decodeByUsage } from './numeric';
import { segmentBody, formatSegments, plainSegments } from './autodetect';

export interface Group {
  key: string;
  length: number;
  entries: Uint32Array;
  copybook: { name: string; copybook: Copybook } | null;
  loadError?: string;
  columns: Column[];
  banner: Banner;
}

export interface GroupInfo {
  key: string;
  length: number;
  count: number;
  copybookName: string | null;
  banner: Banner;
  columns: Column[];
}

export interface InitPayload {
  type: 'init';
  fileName: string;
  size: number;
  encoding: string;
  encodings: string[];
  total: number;
  errorCount: number;
  orderCount: number;
  groups: GroupInfo[];
  mismatch: MismatchMode;
  /** 没有 copybook 时是否自动识别 COMP-3 */
  autoPacked: boolean;
}

export interface RecRow {
  t: 'rec';
  /** 条目序号（从 0 开始，文件中的第几条） */
  e: number;
  /** 偏移 */
  o: number;
  g: string;
  c: string[];
  /** 需要标橙的列下标 */
  w: number[];
}
export interface ErrRow {
  t: 'err';
  e: number;
  o: number;
  g: 'ERR';
  c: string[];
}
export interface HdrRow {
  t: 'hdr';
  g: string;
  k: number;
}
export type Row = RecRow | ErrRow | HdrRow;

export interface CellInfo {
  name: string;
  pic: string;
  start: number;
  len: number;
  text: string;
  hex: string;
  warn: boolean;
}

export const ERR_VIEW = 'ERR';
export const ORDER_VIEW = 'ORDER';

const fmtOffset = (n: number): string => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

export class RdwSession {
  readonly index: RdwIndex;
  readonly groups: Group[] = [];
  private errorEntries: Uint32Array = new Uint32Array(0);
  private entryGroup: Int32Array;
  private displayRows: Int32Array = new Int32Array(0);
  private decoder: TextDecoder;
  private encoding: string;
  private mismatch: MismatchMode;
  private littleEndian: boolean;
  private autoPacked: boolean;

  constructor(
    private readonly buf: Uint8Array,
    private readonly fileName: string,
    opts: { encoding?: string; mismatch?: MismatchMode; binaryEndian?: 'big' | 'little'; autoPacked?: boolean } = {}
  ) {
    this.encoding = opts.encoding ?? 'shift_jis';
    this.decoder = createDecoder(this.encoding) ?? createDecoder('shift_jis')!;
    if (!createDecoder(this.encoding)) {
      this.encoding = 'shift_jis';
    }
    this.mismatch = opts.mismatch ?? 'lenient';
    this.littleEndian = opts.binaryEndian === 'little';
    this.autoPacked = opts.autoPacked ?? true;
    this.index = scanRdw(buf);
    this.entryGroup = new Int32Array(this.index.count).fill(-1);
    this.buildGroups();
  }

  private buildGroups(): void {
    const { index } = this;
    const byLen = new Map<number, number[]>();
    const errs: number[] = [];
    for (let e = 0; e < index.count; e++) {
      if (index.isError[e]) {
        errs.push(e);
        continue;
      }
      const len = index.lengths[e];
      let list = byLen.get(len);
      if (!list) {
        list = [];
        byLen.set(len, list);
      }
      list.push(e);
    }
    this.errorEntries = Uint32Array.from(errs);
    for (const [length, list] of byLen) {
      const g: Group = {
        key: `L${length}`,
        length,
        entries: Uint32Array.from(list),
        copybook: null,
        columns: [],
        banner: { level: 'warn', text: '' },
      };
      this.groups.push(g);
      const gi = this.groups.length - 1;
      for (const e of list) {
        this.entryGroup[e] = gi;
      }
      this.refreshGroup(g);
    }

    // 文件顺序视图：copybook 切换（即长度变化）时插入 3 行表头
    const display: number[] = [];
    let lastGi = -1;
    for (let e = 0; e < index.count; e++) {
      const gi = this.entryGroup[e];
      if (gi >= 0 && gi !== lastGi) {
        for (let k = 0; k < 3; k++) {
          display.push(-1 - (gi * 3 + k));
        }
        lastGi = gi;
      }
      display.push(e);
    }
    this.displayRows = Int32Array.from(display);
  }

  private refreshGroup(g: Group): void {
    const set = buildColumns(g.length, g.copybook, this.mismatch, g.loadError);
    g.columns = set.columns;
    g.banner = set.banner;
    this.fitBodyWidth(g);
  }

  /**
   * 「整条正文」列：按抽样记录的实际显示内容确定列宽。
   * 自动识别 COMP-3 后显示文字可能比字节数长（[+11850] 比 3 字节长），末尾空格则不显示，
   * 所以按字节数估算会截断或留下大片空白。抽样（开头 100 条 + 均匀分布 100 条）可让列宽稳定，不随滚动变化。
   */
  private fitBodyWidth(g: Group): void {
    const col = g.columns.find((c) => c.kind === 'body');
    if (!col) {
      return;
    }
    const idx = g.columns.indexOf(col);
    const n = g.entries.length;
    const picks = new Set<number>();
    for (let i = 0; i < Math.min(n, 100); i++) {
      picks.add(i);
    }
    const step = Math.max(1, Math.floor(n / 100));
    for (let i = 0; i < n; i += step) {
      picks.add(i);
    }
    let max = 0;
    for (const i of picks) {
      const text = plainSegments(this.cell(g.entries[i], g.columns[idx]).text);
      max = Math.max(max, displayWidth(text));
    }
    col.width = Math.min(Math.max(max + 2, displayWidth(col.pic) + 2, 6), 3000);
  }

  groupByKey(key: string): Group | undefined {
    return this.groups.find((g) => g.key === key);
  }

  setCopybook(length: number, ref: { name: string; copybook: Copybook } | null, loadError?: string): void {
    const g = this.groups.find((x) => x.length === length);
    if (!g) {
      return;
    }
    g.copybook = ref;
    g.loadError = loadError;
    this.refreshGroup(g);
  }

  setEncoding(label: string): boolean {
    const d = createDecoder(label);
    if (!d) {
      return false;
    }
    this.decoder = d;
    this.encoding = label;
    this.groups.forEach((g) => this.fitBodyWidth(g));
    return true;
  }

  setAutoPacked(on: boolean): void {
    this.autoPacked = on;
    this.groups.forEach((g) => this.fitBodyWidth(g));
  }

  setMismatchMode(mode: MismatchMode): void {
    this.mismatch = mode;
    for (const g of this.groups) {
      this.refreshGroup(g);
    }
  }

  init(): InitPayload {
    return {
      type: 'init',
      fileName: this.fileName,
      size: this.index.size,
      encoding: this.encoding,
      encodings: SUPPORTED_ENCODINGS,
      total: this.index.count,
      errorCount: this.errorEntries.length,
      orderCount: this.displayRows.length,
      mismatch: this.mismatch,
      autoPacked: this.autoPacked,
      groups: this.groups.map((g) => ({
        key: g.key,
        length: g.length,
        count: g.entries.length,
        copybookName: g.copybook ? g.copybook.name : null,
        banner: g.banner,
        columns: g.columns,
      })),
    };
  }

  private slice(entry: number, col: Column): Uint8Array {
    const base = this.index.offsets[entry] + RDW_SIZE + (col.start - 1);
    return this.buf.subarray(base, base + col.len);
  }

  private cell(entry: number, col: Column): { text: string; warn: boolean } {
    if (col.kind === 'missing') {
      return { text: '—', warn: true };
    }
    const bytes = this.slice(entry, col);
    if (col.type === 'bin') {
      if (col.kind === 'partial') {
        return { text: toHex(bytes), warn: true };
      }
      // COMP-3 / COMP 等解码成数值；内容不合法或不认识的 USAGE 回退为十六进制并标橙/不标橙
      const d = decodeByUsage(bytes, col.usage, col.scale, col.signed, this.littleEndian);
      if (!d) {
        return { text: toHex(bytes), warn: false };
      }
      return d.ok ? { text: d.text, warn: false } : { text: toHex(bytes), warn: true };
    }
    if (col.kind === 'body' && this.autoPacked) {
      // 没有 copybook：自动识别 COMP-3，其余按文字 / 十六进制显示
      const sjis = /shift|sjis|31j/i.test(this.encoding);
      return { text: formatSegments(bytes, segmentBody(bytes, sjis), this.decoder).trimEnd(), warn: false };
    }
    const raw = this.decoder.decode(bytes);
    let warn = col.kind === 'partial' || col.kind === 'extra' || raw.includes('�');
    if (col.type === 'num' && col.kind !== 'partial') {
      let body = raw;
      if (col.signed && body.length > 0 && /[{}A-Ra-r]/.test(body[body.length - 1])) {
        body = body.slice(0, -1); // 符号嵌入末位（overpunch）
      }
      if (!/^[0-9+\-. ]*$/.test(body)) {
        warn = true;
      }
    }
    // 整条正文列不显示末尾空格（避免撑出大片空白；完整内容可点击单元格查看）
    return { text: col.kind === 'body' ? sanitize(raw).trimEnd() : sanitize(raw), warn };
  }

  private recRow(g: Group, entry: number): RecRow {
    const c: string[] = [];
    const w: number[] = [];
    g.columns.forEach((col, i) => {
      const r = this.cell(entry, col);
      c.push(r.text);
      if (r.warn) {
        w.push(i);
      }
    });
    return { t: 'rec', e: entry, o: this.index.offsets[entry], g: g.key, c, w };
  }

  private errRow(entry: number): ErrRow {
    return {
      t: 'err',
      e: entry,
      o: this.index.offsets[entry],
      g: ERR_VIEW,
      c: [fmtOffset(this.index.offsets[entry]), String(this.index.lengths[entry]), this.index.errors.get(entry) ?? ''],
    };
  }

  private entryRow(entry: number): Row {
    if (this.index.isError[entry]) {
      return this.errRow(entry);
    }
    return this.recRow(this.groups[this.entryGroup[entry]], entry);
  }

  count(view: string): number {
    if (view === ORDER_VIEW) {
      return this.displayRows.length;
    }
    if (view === ERR_VIEW) {
      return this.errorEntries.length;
    }
    return this.groupByKey(view)?.entries.length ?? 0;
  }

  getRows(view: string, start: number, count: number): Row[] {
    const total = this.count(view);
    const end = Math.min(total, start + count);
    const rows: Row[] = [];
    for (let i = Math.max(0, start); i < end; i++) {
      if (view === ORDER_VIEW) {
        const v = this.displayRows[i];
        if (v >= 0) {
          rows.push(this.entryRow(v));
        } else {
          const code = -1 - v;
          rows.push({ t: 'hdr', g: this.groups[Math.floor(code / 3)].key, k: code % 3 });
        }
      } else if (view === ERR_VIEW) {
        rows.push(this.errRow(this.errorEntries[i]));
      } else {
        const g = this.groupByKey(view);
        if (g) {
          rows.push(this.recRow(g, g.entries[i]));
        }
      }
    }
    return rows;
  }

  cellInfo(groupKey: string, entry: number, colIndex: number): CellInfo | undefined {
    const g = this.groupByKey(groupKey);
    if (!g || this.index.isError[entry]) {
      return undefined;
    }
    const col = g.columns[colIndex];
    if (!col) {
      return undefined;
    }
    const r = this.cell(entry, col);
    return {
      name: col.name,
      pic: col.pic,
      start: col.start,
      len: col.len,
      text: plainSegments(r.text),
      hex: toHex(this.slice(entry, col)),
      warn: r.warn,
    };
  }
}
