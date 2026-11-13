/**
 * 一个已打开文件的数据模型：持有字节数据源（内存或分页大文件）、RDW 索引、按长度分组的结果，
 * 并按需（虚拟滚动）解码出行数据。不依赖 VS Code，便于测试。
 */
import { t } from './i18n';
import { ByteSource, toByteSource } from './source';
import { RdwIndex, ScanProgress, scanRdw, scanRdwAsync, RDW_SIZE } from './rdw';
import { Copybook, LayoutSelection } from './copybook';
import { Banner, Column, LayoutChoice, MismatchMode, buildColumns, displayWidth } from './layout';
import { SUPPORTED_ENCODINGS, createDecoder, dumpChars, sanitize, toHex } from './decode';
import { decodePacked, decodeNumeric, decodeZoned, NumericOptions } from './numeric';
import { segmentBody, formatSegments, plainSegments } from './autodetect';

/** 判别字段：同一长度的记录，按这个字段的值选用不同的 copybook */
export type DiscriminatorType = 'text' | 'comp3';
export interface Discriminator {
  /** 在正文中的起始位置（从 1 开始） */
  start: number;
  length: number;
  type: DiscriminatorType;
}

export function discriminatorLabel(d: Discriminator): string {
  return t('disc.label', { from: d.start, to: d.start + d.length - 1, type: d.type === 'comp3' ? 'COMP-3' : t('disc.text') });
}

type CopybookRef = { name: string; copybook: Copybook };

export interface SessionOptions {
  encoding?: string;
  mismatch?: MismatchMode;
  /** COMP / COMP-4 / BINARY 的字节序 */
  binaryEndian?: 'big' | 'little';
  /** COMP-5 / COMP-1 / COMP-2 的字节序；省略时与 binaryEndian 相同 */
  comp5Endian?: 'big' | 'little';
  floatFormat?: 'ieee' | 'ibm';
  autoPacked?: boolean;
}

export interface Group {
  key: string;
  length: number;
  /** 按判别字段分组时的字段值；未按字段值区分时为 undefined */
  value?: string;
  entries: Uint32Array;
  copybook: { name: string; copybook: Copybook } | null;
  loadError?: string;
  /** copybook 未保存设置、按长度自动选择的 */
  auto: boolean;
  columns: Column[];
  banner: Banner;
  /** REDEFINES / 01 记录的布局选择 */
  layoutSel: LayoutSelection;
  /** 当前可以切换的布局 */
  choices: LayoutChoice[];
}

export interface GroupInfo {
  key: string;
  length: number;
  value: string | null;
  discLabel: string | null;
  count: number;
  copybookName: string | null;
  /** copybook 是按长度自动选择的 */
  auto: boolean;
  banner: Banner;
  columns: Column[];
  choices: LayoutChoice[];
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
  /** 外部十进制（DISPLAY 数字）解码后的数值，便于确认小数位、符号 */
  value?: string;
  name: string;
  pic: string;
  start: number;
  len: number;
  text: string;
  hex: string;
  warn: boolean;
}

/** 十六进制 dump 中的字段范围 */
export interface DumpField {
  name: string;
  /** 从 1 开始的位置 */
  start: number;
  len: number;
  /** 对应的列下标 */
  col: number;
}

/** 一条记录（或错误条目跳过的字节）的十六进制 dump */
export interface DumpInfo {
  entry: number;
  /** 文件内偏移：正常记录为前置 RDW 的位置，错误条目为出错位置 */
  offset: number;
  groupKey: string | null;
  /** 错误条目的原因；正常记录为 null */
  error: string | null;
  /** 前置 / 后置 RDW 的十六进制（错误条目为 null） */
  front: string | null;
  back: string | null;
  bytes: number[];
  /** 文字栏：多字节字符在首字节位置，后续字节为空字符串 */
  chars: string[];
  fields: DumpField[];
  /** 错误条目的字节过多时只取开头部分 */
  truncated: boolean;
}

/** 错误条目的 dump 最多显示的字节数 */
export const DUMP_ERROR_LIMIT = 4096;

export const ERR_VIEW = 'ERR';
export const ORDER_VIEW = 'ORDER';

const fmtOffset = (n: number): string => '0x' + n.toString(16).toUpperCase().padStart(8, '0');

/**
 * 针对单个判别字段的字节级去重解码缓存（开放定址哈希表）：
 * 判别字段通常只有寥寥几种取值（如 '01'/'02'/'03' 或几个 COMP-3 代码），
 * 用原始字节直接命中已解码的字符串，避免百万条记录重复调用 TextDecoder / trimEnd / 正则替换。
 */
class DiscValueCache {
  private cap = 64;
  private size = 0;
  private hashes = new Uint32Array(64);
  private used = new Uint8Array(64);
  private rawKeys: Uint8Array[] = new Array(64);
  private values: string[] = new Array(64);

  constructor(
    private readonly d: Discriminator,
    private readonly decoder: TextDecoder
  ) {}

  private decode(bytes: Uint8Array): string {
    if (this.d.type === 'comp3') {
      const signed = (bytes[bytes.length - 1] & 0x0f) !== 0xf;
      const r = decodePacked(bytes, 0, signed);
      return r.ok ? r.text : t('disc.invalid', { hex: toHex(bytes) });
    }
    return sanitize(this.decoder.decode(bytes)).trimEnd() || t('disc.blank');
  }

  private grow(): void {
    const oldCap = this.cap;
    const oldHashes = this.hashes;
    const oldUsed = this.used;
    const oldKeys = this.rawKeys;
    const oldVals = this.values;

    this.cap = oldCap * 2;
    this.hashes = new Uint32Array(this.cap);
    this.used = new Uint8Array(this.cap);
    this.rawKeys = new Array(this.cap);
    this.values = new Array(this.cap);
    const mask = this.cap - 1;

    for (let i = 0; i < oldCap; i++) {
      if (!oldUsed[i]) continue;
      let slot = oldHashes[i] & mask;
      while (this.used[slot]) {
        slot = (slot + 1) & mask;
      }
      this.used[slot] = 1;
      this.hashes[slot] = oldHashes[i];
      this.rawKeys[slot] = oldKeys[i];
      this.values[slot] = oldVals[i];
    }
  }

  get(bytes: Uint8Array): string {
    const len = bytes.length;
    let h = 0x811c9dc5;
    for (let i = 0; i < len; i++) {
      h = Math.imul(h ^ bytes[i], 0x01000193);
    }
    h >>>= 0;

    let mask = this.cap - 1;
    let slot = h & mask;
    while (this.used[slot]) {
      if (this.hashes[slot] === h) {
        const k = this.rawKeys[slot];
        if (k.length === len) {
          let eq = true;
          for (let i = 0; i < len; i++) {
            if (k[i] !== bytes[i]) {
              eq = false;
              break;
            }
          }
          if (eq) {
            return this.values[slot];
          }
        }
      }
      slot = (slot + 1) & mask;
    }

    const val = this.decode(bytes);
    // 拷贝一份独立字节作为缓存键（分页源返回的视图可能被复用覆盖）
    const copy = bytes.slice();
    if ((this.size + 1) * 2 >= this.cap) {
      this.grow();
      mask = this.cap - 1;
      slot = h & mask;
      while (this.used[slot]) {
        slot = (slot + 1) & mask;
      }
    }
    this.used[slot] = 1;
    this.hashes[slot] = h;
    this.rawKeys[slot] = copy;
    this.values[slot] = val;
    this.size++;
    return val;
  }
}

export class RdwSession {
  readonly source: ByteSource;
  readonly index: RdwIndex;
  readonly groups: Group[] = [];
  /** 长度 → 判别字段 */
  private discriminators = new Map<number, Discriminator>();
  /** 分组键 → 已指定的 copybook（重新分组后保留） */
  private assigned = new Map<string, { ref: CopybookRef | null; loadError?: string; auto?: boolean }>();
  /** 分组键 → 布局选择（重新分组后保留） */
  private selections = new Map<string, LayoutSelection>();
  private errorEntries: Uint32Array = new Uint32Array(0);
  private entryGroup: Int32Array;
  private displayRows: Int32Array = new Int32Array(0);
  private decoder: TextDecoder;
  private encoding: string;
  private mismatch: MismatchMode;
  private numOpts: NumericOptions;
  private autoPacked: boolean;

  constructor(
    input: Uint8Array | ByteSource,
    private readonly fileName: string,
    opts: SessionOptions = {},
    precomputedIndex?: RdwIndex
  ) {
    this.source = toByteSource(input);
    this.encoding = opts.encoding ?? 'shift_jis';
    this.decoder = createDecoder(this.encoding) ?? createDecoder('shift_jis')!;
    if (!createDecoder(this.encoding)) {
      this.encoding = 'shift_jis';
    }
    this.mismatch = opts.mismatch ?? 'lenient';
    const binaryLittle = opts.binaryEndian === 'little';
    this.numOpts = {
      binaryLittleEndian: binaryLittle,
      comp5LittleEndian: opts.comp5Endian ? opts.comp5Endian === 'little' : binaryLittle,
      floatFormat: opts.floatFormat ?? 'ieee',
    };
    this.autoPacked = opts.autoPacked ?? true;
    this.index = precomputedIndex ?? scanRdw(this.source);
    this.entryGroup = new Int32Array(this.index.count).fill(-1);
    this.buildGroups();
  }

  /**
   * 异步创建会话（在扫描超大文件时定期交还事件循环、支持进度显示与取消）。
   * 若取消则返回 undefined（注意调用方应自行 close 传入的 ByteSource）。
   */
  static async createAsync(
    input: Uint8Array | ByteSource,
    fileName: string,
    opts: SessionOptions = {},
    progress: ScanProgress = {}
  ): Promise<RdwSession | undefined> {
    const src = toByteSource(input);
    const index = await scanRdwAsync(src, progress);
    if (!index) {
      return undefined;
    }
    return new RdwSession(src, fileName, opts, index);
  }

  /** 关闭底层文件句柄（内存模式下无操作） */
  close(): void {
    this.source.close();
  }

  static groupKey(length: number, value?: string): string {
    return value === undefined ? `L${length}` : `L${length}=${value}`;
  }

  private discCaches(): Map<number, DiscValueCache> {
    const caches = new Map<number, DiscValueCache>();
    for (const [len, d] of this.discriminators) {
      caches.set(len, new DiscValueCache(d, this.decoder));
    }
    return caches;
  }

  /** 读取判别字段的值（优先走字节哈希缓存，避免大量记录重复解码） */
  private discValue(entry: number, d: Discriminator, cache?: DiscValueCache): string {
    const bodyLen = this.index.lengths[entry];
    if (d.start - 1 + d.length > bodyLen) {
      return t('disc.outOfRange');
    }
    const base = this.index.offsets[entry] + RDW_SIZE + d.start - 1;
    const bytes = this.source.read(base, d.length);
    if (cache) {
      return cache.get(bytes);
    }
    if (d.type === 'comp3') {
      const signed = (bytes[bytes.length - 1] & 0x0f) !== 0xf;
      const r = decodePacked(bytes, 0, signed);
      return r.ok ? r.text : t('disc.invalid', { hex: toHex(bytes) });
    }
    return sanitize(this.decoder.decode(bytes)).trimEnd() || t('disc.blank');
  }

  private buildGroups(): void {
    const { index } = this;
    const total = index.count;
    const caches = this.discriminators.size > 0 ? this.discCaches() : undefined;

    // 第一遍：确定每个条目的分组下标与各分组容量（用 TypedArray 代替巨型 number[] 列表）
    const byKey = new Map<string, { gi: number; length: number; value?: string; count: number }>();
    let errCount = 0;
    for (let e = 0; e < total; e++) {
      if (index.isError[e]) {
        this.entryGroup[e] = -1;
        errCount++;
        continue;
      }
      const length = index.lengths[e];
      const d = this.discriminators.get(length);
      const value = d ? this.discValue(e, d, caches?.get(length)) : undefined;
      const key = RdwSession.groupKey(length, value);
      let slot = byKey.get(key);
      if (!slot) {
        slot = { gi: byKey.size, length, value, count: 0 };
        byKey.set(key, slot);
      }
      slot.count++;
      this.entryGroup[e] = slot.gi;
    }

    // 预分配精确大小的 TypedArray
    this.errorEntries = new Uint32Array(errCount);
    const groupEntries: Uint32Array[] = [];
    const groupCursors = new Uint32Array(byKey.size);
    for (const [, slot] of byKey) {
      groupEntries.push(new Uint32Array(slot.count));
    }

    // 第二遍：填充 entries 与计算 ORDER 视图的总行数
    let errPos = 0;
    let orderLen = 0;
    let lastGi = -1;
    for (let e = 0; e < total; e++) {
      const gi = this.entryGroup[e];
      if (gi < 0) {
        this.errorEntries[errPos++] = e;
      } else {
        groupEntries[gi][groupCursors[gi]++] = e;
        if (gi !== lastGi) {
          orderLen += 3;
          lastGi = gi;
        }
      }
      orderLen++;
    }

    for (const [key, slot] of byKey) {
      const a = this.assigned.get(key);
      const g: Group = {
        key,
        length: slot.length,
        value: slot.value,
        entries: groupEntries[slot.gi],
        copybook: a?.ref ?? null,
        loadError: a?.loadError,
        auto: !!a?.auto,
        columns: [],
        banner: { level: 'warn', text: '' },
        layoutSel: this.selections.get(key) ?? {},
        choices: [],
      };
      this.groups.push(g);
      this.refreshGroup(g);
    }

    // 文件顺序视图：分组（即 copybook）切换时插入 3 行表头（直接写入 Int32Array，零中间数组）
    const display = new Int32Array(orderLen);
    let dp = 0;
    lastGi = -1;
    for (let e = 0; e < total; e++) {
      const gi = this.entryGroup[e];
      if (gi >= 0 && gi !== lastGi) {
        for (let k = 0; k < 3; k++) {
          display[dp++] = -1 - (gi * 3 + k);
        }
        lastGi = gi;
      }
      display[dp++] = e;
    }
    this.displayRows = display;
  }

  private rebuild(): void {
    this.groups.length = 0;
    this.entryGroup.fill(-1);
    this.buildGroups();
  }

  private refreshGroup(g: Group): void {
    const set = buildColumns(g.length, g.copybook, this.mismatch, g.loadError, g.layoutSel);
    g.columns = set.columns;
    g.banner = set.banner;
    g.choices = set.choices;
    const d = this.discriminators.get(g.length);
    if (g.auto && g.copybook) {
      g.banner = { ...g.banner, text: t('banner.autoPrefix', { name: g.copybook.name }) + g.banner.text };
    }
    if (g.value !== undefined && d) {
      g.banner = { ...g.banner, text: t('disc.bannerPrefix', { label: discriminatorLabel(d), value: g.value }) + g.banner.text };
    }
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

  /**
   * 为某个分组指定 copybook。value 为判别字段的值；未按字段值区分时省略。
   * 指定结果按分组键记住，重新分组后仍然有效。
   * auto=true 表示没有保存的设置、按长度自动选择（提示条中注明）。
   */
  setCopybook(length: number, ref: CopybookRef | null, loadError?: string, value?: string, auto = false): void {
    const key = RdwSession.groupKey(length, value);
    this.assigned.set(key, { ref, loadError, auto });
    const g = this.groupByKey(key);
    if (!g) {
      return;
    }
    g.copybook = ref;
    g.loadError = loadError;
    g.auto = auto && !!ref;
    this.refreshGroup(g);
  }

  /**
   * 切换布局（REDEFINES 或同长度的多个 01）。value 为判别字段的值；未按字段值区分时省略。
   * option 为 undefined 时恢复默认。
   */
  setLayout(length: number, id: string, option: string | undefined, value?: string): void {
    const key = RdwSession.groupKey(length, value);
    const sel = { ...(this.selections.get(key) ?? {}) };
    if (option === undefined) {
      delete sel[id];
    } else {
      sel[id] = option;
    }
    this.selections.set(key, sel);
    const g = this.groupByKey(key);
    if (g) {
      g.layoutSel = sel;
      this.refreshGroup(g);
    }
  }

  /** 一次设置某个分组的全部布局选择（从配置恢复时使用） */
  setLayoutSelection(length: number, sel: LayoutSelection, value?: string): void {
    const key = RdwSession.groupKey(length, value);
    this.selections.set(key, { ...sel });
    const g = this.groupByKey(key);
    if (g) {
      g.layoutSel = { ...sel };
      this.refreshGroup(g);
    }
  }

  getDiscriminator(length: number): Discriminator | undefined {
    return this.discriminators.get(length);
  }

  /** 按判别字段区分（d=null 取消）；会重新分组 */
  setDiscriminator(length: number, d: Discriminator | null): void {
    const cur = this.discriminators.get(length);
    if (JSON.stringify(cur ?? null) === JSON.stringify(d)) {
      return;
    }
    if (d) {
      this.discriminators.set(length, d);
    } else {
      this.discriminators.delete(length);
    }
    this.rebuild();
  }

  /** 预览：某个长度的记录在判别字段上有哪些值、各多少条（按条数从多到少） */
  discriminatorValues(length: number, d: Discriminator): Array<{ value: string; count: number }> {
    const counts = new Map<string, number>();
    const cache = new DiscValueCache(d, this.decoder);
    for (let e = 0; e < this.index.count; e++) {
      if (!this.index.isError[e] && this.index.lengths[e] === length) {
        const v = this.discValue(e, d, cache);
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
    }
    return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  }

  setEncoding(label: string): boolean {
    const d = createDecoder(label);
    if (!d) {
      return false;
    }
    this.decoder = d;
    this.encoding = label;
    if ([...this.discriminators.values()].some((x) => x.type === 'text')) {
      this.rebuild();
    } else {
      this.groups.forEach((g) => this.fitBodyWidth(g));
    }
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
        value: g.value ?? null,
        discLabel: g.value !== undefined && this.discriminators.has(g.length) ? discriminatorLabel(this.discriminators.get(g.length)!) : null,
        count: g.entries.length,
        copybookName: g.copybook ? g.copybook.name : null,
        auto: g.auto,
        banner: g.banner,
        columns: g.columns,
        choices: g.choices,
      })),
    };
  }

  /** 某条记录中某一列的字节 */
  slice(entry: number, col: Column): Uint8Array {
    const base = this.index.offsets[entry] + RDW_SIZE + (col.start - 1);
    return this.source.read(base, col.len);
  }

  /** 单元格的显示文字和是否标橙 */
  cell(entry: number, col: Column): { text: string; warn: boolean } {
    if (col.kind === 'missing') {
      return { text: '—', warn: true };
    }
    const bytes = this.slice(entry, col);
    if (col.type === 'bin') {
      if (col.kind === 'partial') {
        return { text: toHex(bytes), warn: true };
      }
      // COMP-3 / COMP 等解码成数值。非法 → 十六进制并标橙；可疑（超出 PIC 位数等）→ 数值并标橙
      const d = decodeNumeric(bytes, col, this.numOpts);
      if (!d) {
        return { text: toHex(bytes), warn: false };
      }
      return d.ok ? { text: d.text, warn: !!d.suspect } : { text: toHex(bytes), warn: true };
    }
    if (col.kind === 'body' && this.autoPacked) {
      // 没有 copybook：自动识别 COMP-3，其余按文字 / 十六进制显示
      const sjis = /shift|sjis|31j/i.test(this.encoding);
      return { text: formatSegments(bytes, segmentBody(bytes, sjis), this.decoder).trimEnd(), warn: false };
    }
    const raw = this.decoder.decode(bytes);
    let warn = col.kind === 'partial' || col.kind === 'extra' || raw.includes('\ufffd');
    if (col.type === 'num' && col.kind !== 'partial' && !decodeZoned(bytes, col).ok) {
      // 外部十进制：空格、符号位置错误等都视为非法（原样显示并标橙）
      warn = true;
    }
    // 整条正文（关闭自动识别时）去掉末尾空格，避免右侧大片空白；拆分的字段保留原始长度以便看清补位
    const text = sanitize(raw);
    return { text: col.kind === 'body' ? text.trimEnd() : text, warn };
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

  /** 某个条目的行数据（正常记录或错误条目） */
  entryRow(entry: number): Row {
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
      value: col.type === 'num' && col.kind === 'field' ? decodeZoned(this.slice(entry, col), col).text || undefined : undefined,
      text: plainSegments(r.text),
      hex: toHex(this.slice(entry, col)),
      warn: r.warn,
    };
  }

  /** 条目所属的分组（错误条目为 undefined） */
  groupOfEntry(entry: number): Group | undefined {
    const gi = this.entryGroup[entry];
    return gi >= 0 ? this.groups[gi] : undefined;
  }

  /** 若数据源为完整内存缓冲区则直接返回（供零拷贝加速），分页文件模式下为 undefined */
  get raw(): Uint8Array | undefined {
    return this.source.raw;
  }

  /** 记录正文在文件中的起始偏移 */
  bodyOffset(entry: number): number {
    return this.index.offsets[entry] + RDW_SIZE;
  }

  /** 记录正文的长度 */
  bodyLength(entry: number): number {
    return this.index.lengths[entry];
  }

  /** 记录正文 */
  body(entry: number): Uint8Array {
    return this.source.read(this.index.offsets[entry] + RDW_SIZE, this.index.lengths[entry]);
  }

  /** 正常记录（非错误条目）的条目序号，按文件顺序返回紧凑的 Uint32Array */
  recordEntries(): Uint32Array {
    const total = this.index.count;
    const okCount = total - this.errorEntries.length;
    const out = new Uint32Array(okCount);
    let p = 0;
    for (let e = 0; e < total; e++) {
      if (!this.index.isError[e]) {
        out[p++] = e;
      }
    }
    return out;
  }

  /** 十六进制 dump：正常记录为正文（另附前后 RDW），错误条目为跳过的字节 */
  recordDump(entry: number): DumpInfo | undefined {
    if (entry < 0 || entry >= this.index.count) {
      return undefined;
    }
    const offset = this.index.offsets[entry];
    if (this.index.isError[entry]) {
      const len = Math.min(this.index.lengths[entry], DUMP_ERROR_LIMIT);
      const bytes = this.source.read(offset, len).slice();
      return {
        entry,
        offset,
        groupKey: null,
        error: this.index.errors.get(entry) ?? '',
        front: null,
        back: null,
        bytes: Array.from(bytes),
        chars: dumpChars(bytes, this.decoder),
        fields: [],
        truncated: this.index.lengths[entry] > len,
      };
    }
    const g = this.groupOfEntry(entry)!;
    const bodyLen = this.index.lengths[entry];
    // 先分别拷贝前后 RDW 与正文，避免跨页读取时共享暂存缓冲区互相覆盖
    const front = toHex(this.source.read(offset, RDW_SIZE));
    const end = offset + RDW_SIZE + bodyLen;
    const back = toHex(this.source.read(end, RDW_SIZE));
    const body = this.body(entry).slice();
    const fields: DumpField[] = [];
    g.columns.forEach((c, i) => {
      if (c.kind !== 'missing' && c.len > 0) {
        fields.push({ name: c.name, start: c.start, len: c.len, col: i });
      }
    });
    return {
      entry,
      offset,
      groupKey: g.key,
      error: null,
      front,
      back,
      bytes: Array.from(body),
      chars: dumpChars(body, this.decoder),
      fields,
      truncated: false,
    };
  }
}
