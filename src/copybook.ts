/**
 * 简易 COBOL copybook 解析器：把 copybook 展开成「叶子字段」列表（名称、偏移、长度、类型）。
 *
 * 支持：
 *  - 固定格式（第 7 列注释/第 8~72 列）和自由格式
 *  - 层级号 01~49、77，FILLER，GROUP
 *  - PIC X/A/9/S/V/Z/N/G 等及 (n) 重复
 *  - USAGE DISPLAY / COMP / COMP-3 / COMP-5 / COMP-1 / COMP-2 等；组项目的 USAGE、SIGN 由下级项目继承
 *  - SIGN [LEADING|TRAILING] SEPARATE（符号占 1 字节）
 *  - OCCURS n（展开为 name(1)、嵌套时 name(1,2)…）
 *  - REDEFINES：原项目与重定义项目共用同一区域（大小取最大者），可切换显示哪一个布局
 *  - 多个 01：按记录长度选用；同长度的多个 01 也可切换
 *
 * 不支持（会产生提示）：OCCURS DEPENDING ON（按最大次数展开）、SYNC 的对齐填充。
 */
import { t } from './i18n';

export type FieldType = 'alnum' | 'num' | 'bin';

export interface CopyField {
  name: string;
  /** PIC 原文（大写），二进制类字段会附带 USAGE */
  pic: string;
  /** 在正文中的偏移（从 0 开始） */
  offset: number;
  length: number;
  type: FieldType;
  signed: boolean;
  /** USAGE（DISPLAY / COMP / COMP-3 …） */
  usage: string;
  /** 小数位数（V 之后的位数） */
  scale: number;
  /** PIC 中 9 的个数（数值项目的位数） */
  digits: number;
  /** 符号单独占 1 字节（SIGN SEPARATE） */
  signSeparate: boolean;
  /** 符号在前（SIGN LEADING）；默认在后 */
  signLeading: boolean;
}

/** 一组可以切换的布局：REDEFINES 的原项目和重定义项目 */
export interface RedefineSet {
  /** 原项目的限定名（如 REC.PAY-INFO.CARD），用来保存选择 */
  id: string;
  /** 原项目名 */
  base: string;
  /** 可选的布局名（第一个为原项目） */
  options: string[];
  /** 区域的起始偏移（从 0 开始）和长度 */
  offset: number;
  length: number;
}

/** 按某种 REDEFINES 选择展开后的布局 */
export interface CopyLayout {
  fields: CopyField[];
  totalLength: number;
  /** 这个布局里出现的可切换区域 */
  sets: RedefineSet[];
}

/** REDEFINES 的选择：区域 id → 布局名 */
export type LayoutSelection = Record<string, string>;

/** copybook 中的一个顶层（01）记录定义（fields / totalLength / sets 为默认布局） */
export interface CopyRecord extends CopyLayout {
  name: string;
  /** 解析树（内部使用） */
  readonly root: unknown;
}

export interface Copybook {
  /** 第一个顶层记录的字段（便于只有一个 01 的常见情况） */
  fields: CopyField[];
  totalLength: number;
  /** 所有顶层记录；有多个 01 时可按记录长度选用 */
  records: CopyRecord[];
  warnings: string[];
}

/** 选用总长度等于记录长度的顶层定义；没有则用第一个 */
export function selectRecord(cb: Copybook, bodyLen: number): CopyRecord | undefined {
  return cb.records.find((r) => r.totalLength === bodyLen) ?? cb.records[0];
}

interface Node {
  level: number;
  name: string;
  pic?: string;
  /** 本项目写明的 USAGE（未写时继承上级） */
  usage?: string;
  occurs: number;
  redefines?: string;
  /** 本项目写明的 SIGN 子句（未写时继承上级） */
  sign?: { separate: boolean; leading: boolean };
  sync: boolean;
  children: Node[];
}

/** 从上级继承的属性 */
interface Inherited {
  usage: string;
  sign: { separate: boolean; leading: boolean };
}

const NO_PIC_USAGES = new Set(['COMP-1', 'COMP-2', 'INDEX', 'POINTER']);

const CLAUSE_STARTS = new Set([
  'PIC', 'PICTURE', 'USAGE', 'COMP', 'COMP-1', 'COMP-2', 'COMP-3', 'COMP-4', 'COMP-5',
  'BINARY', 'PACKED-DECIMAL', 'DISPLAY', 'NATIONAL', 'DISPLAY-1', 'OCCURS', 'REDEFINES',
  'COMPUTATIONAL', 'COMPUTATIONAL-1', 'COMPUTATIONAL-2', 'COMPUTATIONAL-3', 'COMPUTATIONAL-4', 'COMPUTATIONAL-5', 'SIGN', 'SYNC', 'SYNCHRONIZED',
  'JUSTIFIED', 'JUST', 'BLANK', 'EXTERNAL', 'GLOBAL', 'INDEXED', 'INDEX', 'POINTER', 'LEADING', 'TRAILING',
]);

const USAGE_WORDS = new Set([
  'COMP', 'COMP-1', 'COMP-2', 'COMP-3', 'COMP-4', 'COMP-5', 'BINARY', 'PACKED-DECIMAL', 'DISPLAY',
  'NATIONAL', 'DISPLAY-1', 'INDEX', 'POINTER',
]);

/** COMPUTATIONAL-3 → COMP-3 等 */
function normalizeUsage(u: string): string {
  return u.replace(/^COMPUTATIONAL/, 'COMP');
}

/**
 * 字符在源码中占的列数：COBOL 的列按字节计算，Shift_JIS 的全角字符占 2 列
 * （ASCII 和半角片假名占 1 列）。
 */
function columnWidth(ch: string): number {
  const cp = ch.codePointAt(0)!;
  return cp < 0x80 || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2;
}

/** 按列（字节）截取：from、to 为从 0 开始的列位置（不含 to） */
function sliceColumns(line: string, from: number, to: number): string {
  let col = 0;
  let out = '';
  for (const ch of line) {
    const w = columnWidth(ch);
    if (col >= from && col + w <= to) {
      out += ch;
    }
    col += w;
    if (col >= to) {
      break;
    }
  }
  return out;
}

/** 固定格式行：1~6 列为空格或序号数字，第 7 列为指示区 */
const FIXED_LINE = /^(?: {6}|\d{6})[ *\/\-D$]/;

/**
 * 去掉注释、序号区（1~6 列）、标识区（73~80 列），返回拼接后的源码。
 * 逐行判断：以 6 位序号开头的行、或文件大多数行都是固定格式时符合固定格式的行，按固定格式处理；
 * 其余行按自由格式处理。这样一两行格式不规整也不会让整个文件解析失败。
 */
function normalizeSource(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\t/g, '    '));
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const fixedLike = nonEmpty.filter((l) => FIXED_LINE.test(l)).length;
  const mostlyFixed = nonEmpty.length > 0 && fixedLike * 2 >= nonEmpty.length;

  const out: string[] = [];
  for (const raw of lines) {
    let content: string;
    if (/^\d{6}/.test(raw) || (mostlyFixed && FIXED_LINE.test(raw))) {
      const indicator = raw[6] ?? ' ';
      if (indicator === '*' || indicator === '/' || indicator === 'D') {
        continue;
      }
      content = sliceColumns(raw, 7, 72); // 第 8~72 列（按字节计）
    } else {
      content = raw.trim();
      if (content.startsWith('*')) {
        continue;
      }
    }
    const c = content.indexOf('*>');
    out.push(c >= 0 ? content.slice(0, c) : content);
  }
  return out.join(' ');
}

function splitStatements(src: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      cur += ch;
      if (ch === quote) {
        quote = '';
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '.' && (i + 1 >= src.length || /\s/.test(src[i + 1]))) {
      if (cur.trim()) {
        out.push(cur.trim());
      }
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) {
    out.push(cur.trim());
  }
  return out;
}

export interface PicInfo {
  length: number;
  digits: number;
  scale: number;
  type: FieldType;
  signed: boolean;
}

export function picInfo(pic: string, usage: string, signSeparate: boolean): PicInfo {
  const up = pic.toUpperCase();
  const signed = up.startsWith('S');
  let len = 0;
  let digits = 0;
  let numeric = true;
  let scale = 0;
  let afterV = false;
  const re = /(CR|DB|[A-Z0-9.,+\-*$\/])(?:\((\d+)\))?/g;
  for (const m of up.matchAll(re)) {
    const sym = m[1];
    const n = m[2] ? parseInt(m[2], 10) : 1;
    if (sym === 'V') {
      afterV = true;
      continue;
    }
    if (sym === 'S' || sym === 'P') {
      continue;
    }
    // N（日文/National）、G（DBCS）每个字符 2 字节
    len += n * (sym === 'CR' || sym === 'DB' || sym === 'N' || sym === 'G' ? 2 : 1);
    if (afterV) {
      scale += n;
    }
    if (sym === '9') {
      digits += n;
    } else {
      numeric = false;
    }
  }

  switch (usage) {
    case 'COMP':
    case 'COMP-4':
    case 'COMP-5':
    case 'BINARY':
      return { length: digits <= 4 ? 2 : digits <= 9 ? 4 : 8, digits, scale, type: 'bin', signed };
    case 'COMP-3':
    case 'PACKED-DECIMAL':
      return { length: Math.ceil((digits + 1) / 2), digits, scale, type: 'bin', signed };
    case 'COMP-1':
      return { length: 4, digits, scale, type: 'bin', signed };
    case 'COMP-2':
      return { length: 8, digits, scale, type: 'bin', signed };
    case 'INDEX':
    case 'POINTER':
      return { length: 4, digits, scale, type: 'bin', signed };
    default:
      return {
        length: len + (signed && signSeparate ? 1 : 0),
        digits,
        scale,
        type: numeric ? 'num' : 'alnum',
        signed,
      };
  }
}

const LEVEL_RE = /^(?:0?[1-9]|[1-4][0-9]|66|77|88)$/;
/** 可以安静跳过的非数据描述语句 */
const IGNORABLE = new Set(['EJECT', 'SKIP1', 'SKIP2', 'SKIP3', 'COPY', 'REPLACE', 'TITLE']);

function parseStatement(stmt: string, warnings: string[]): Node | undefined {
  let tokens: string[] = stmt.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s]+/g) ?? [];
  if (tokens.length === 0) {
    return undefined;
  }
  if (!LEVEL_RE.test(tokens[0])) {
    const at = tokens.findIndex((t) => LEVEL_RE.test(t));
    if (at < 0) {
      if (!IGNORABLE.has(tokens[0].toUpperCase())) {
        warnings.push(t('cpy.unknownStmt', { stmt: stmt.slice(0, 40) }));
      }
      return undefined;
    }
    warnings.push(t('cpy.unknownPrefix', { text: tokens.slice(0, at).join(' ').slice(0, 30) }));
    tokens = tokens.slice(at);
  }
  const level = parseInt(tokens[0], 10);
  if (level === 66 || level === 88) {
    return undefined;
  }

  const node: Node = {
    level: level === 77 ? 1 : level,
    name: 'FILLER',
    occurs: 1,
    sync: false,
    children: [],
  };

  let i = 1;
  if (tokens[1] && !CLAUSE_STARTS.has(tokens[1].toUpperCase())) {
    node.name = tokens[1];
    i = 2;
  }

  const up = (idx: number): string => (tokens[idx] ?? '').toUpperCase().replace(/,$/, '');

  while (i < tokens.length) {
    const k = up(i);
    if (k === 'PIC' || k === 'PICTURE') {
      i++;
      if (up(i) === 'IS') {
        i++;
      }
      node.pic = (tokens[i] ?? '').replace(/,$/, '').toUpperCase();
      i++;
    } else if (k === 'USAGE') {
      i++;
      if (up(i) === 'IS') {
        i++;
      }
      node.usage = normalizeUsage(up(i) || 'DISPLAY');
      i++;
    } else if (USAGE_WORDS.has(normalizeUsage(k))) {
      node.usage = normalizeUsage(k);
      i++;
    } else if (k === 'OCCURS') {
      i++;
      let n = parseInt(tokens[i] ?? '1', 10);
      i++;
      if (up(i) === 'TO') {
        n = parseInt(tokens[i + 1] ?? String(n), 10);
        i += 2;
      }
      if (up(i) === 'TIMES') {
        i++;
      }
      node.occurs = Number.isFinite(n) && n > 0 ? n : 1;
    } else if (k === 'DEPENDING') {
      warnings.push(t('cpy.occursDepending', { name: node.name }));
      i++;
    } else if (k === 'REDEFINES') {
      node.redefines = tokens[i + 1];
      i += 2;
    } else if (k === 'SIGN' || k === 'LEADING' || k === 'TRAILING') {
      // SIGN [IS] {LEADING|TRAILING} [SEPARATE [CHARACTER]]（SIGN 可省略）
      const sign = { separate: false, leading: false };
      if (k === 'SIGN') {
        i++;
      }
      while (['IS', 'LEADING', 'TRAILING', 'SEPARATE', 'CHARACTER'].includes(up(i))) {
        if (up(i) === 'SEPARATE') sign.separate = true;
        if (up(i) === 'LEADING') sign.leading = true;
        i++;
      }
      node.sign = sign;
    } else if (k === 'SYNC' || k === 'SYNCHRONIZED') {
      node.sync = true;
      i++;
    } else if (k === 'VALUE' || k === 'VALUES') {
      i++;
      while (i < tokens.length && !CLAUSE_STARTS.has(up(i))) {
        i++;
      }
    } else {
      i++;
    }
  }
  return node;
}

const sameName = (a: string | undefined, b: string) => (a ?? '').toUpperCase() === b.toUpperCase();

function isElementary(node: Node, usage: string): boolean {
  return !!node.pic || (node.children.length === 0 && NO_PIC_USAGES.has(usage));
}

function inherit(node: Node, from: Inherited): Inherited {
  return { usage: node.usage ?? from.usage, sign: node.sign ?? from.sign };
}

/** 把相邻的「原项目 + 重定义项目」归为一组；重定义项目的对象可以是原项目或同组中的另一项目 */
function groupSlots(children: Node[], warnings: string[]): Node[][] {
  const slots: Node[][] = [];
  for (const c of children) {
    const last = slots[slots.length - 1];
    if (c.redefines) {
      if (last && last.some((x) => sameName(c.redefines, x.name))) {
        last.push(c);
      } else {
        warnings.push(t('cpy.redefinesTarget', { name: c.name, target: c.redefines }));
      }
      continue;
    }
    slots.push([c]);
  }
  return slots;
}

/** 项目（含 OCCURS 次数）占用的字节数；REDEFINES 区域按最大者计算 */
function sizeOf(node: Node, inh: Inherited, warnings: string[]): number {
  const me = inherit(node, inh);
  let one: number;
  if (isElementary(node, me.usage)) {
    one = picInfo(node.pic ?? '', me.usage, me.sign.separate).length;
  } else {
    one = 0;
    for (const slot of groupSlots(node.children, [])) {
      one += Math.max(...slot.map((c) => sizeOf(c, me, warnings)));
    }
  }
  return one * node.occurs;
}

interface EmitCtx {
  out: CopyField[];
  sets: RedefineSet[];
  sel: LayoutSelection;
  warnings: string[];
}

/** 展开一个项目，返回结束偏移 */
function emit(node: Node, offset: number, idx: number[], path: string, inh: Inherited, ctx: EmitCtx): number {
  const me = inherit(node, inh);
  if (node.sync && (me.usage !== 'DISPLAY' || !node.pic)) {
    ctx.warnings.push(t('cpy.sync', { name: node.name }));
  }
  let off = offset;
  for (let r = 1; r <= node.occurs; r++) {
    const ix = node.occurs > 1 ? [...idx, r] : idx;
    if (isElementary(node, me.usage)) {
      const p = picInfo(node.pic ?? '', me.usage, me.sign.separate);
      const picText = node.pic ?? '';
      ctx.out.push({
        name: node.name + (ix.length ? `(${ix.join(',')})` : ''),
        pic: p.type === 'bin' ? `${picText} ${me.usage}`.trim() : picText,
        offset: off,
        length: p.length,
        type: p.type,
        signed: p.signed,
        usage: me.usage,
        scale: p.scale,
        digits: p.digits,
        signSeparate: p.signed && me.sign.separate,
        signLeading: p.signed && me.sign.leading,
      });
      off += p.length;
    } else {
      off = emitChildren(node.children, off, ix, `${path}.${node.name}`, me, ctx);
    }
  }
  return off;
}

function emitChildren(children: Node[], offset: number, idx: number[], path: string, inh: Inherited, ctx: EmitCtx): number {
  let off = offset;
  for (const slot of groupSlots(children, ctx.warnings)) {
    if (slot.length === 1) {
      off = emit(slot[0], off, idx, path, inh, ctx);
      continue;
    }
    // REDEFINES：只展开选中的布局，区域大小取各布局的最大值（不重复计算）
    const id = `${path}.${slot[0].name}`.replace(/^\./, '');
    const size = Math.max(...slot.map((c) => sizeOf(c, inh, ctx.warnings)));
    if (!ctx.sets.some((x) => x.id === id)) {
      ctx.sets.push({ id, base: slot[0].name, options: slot.map((c) => c.name), offset: off, length: size });
    }
    const chosen = slot.find((c) => sameName(ctx.sel[id], c.name)) ?? slot[0];
    emit(chosen, off, idx, path, inh, ctx);
    off += size;
  }
  return off;
}

const ROOT_INHERITED: Inherited = { usage: 'DISPLAY', sign: { separate: false, leading: false } };

/** 按 REDEFINES 的选择展开一个 01 记录 */
export function layoutRecord(rec: CopyRecord, sel: LayoutSelection = {}): CopyLayout {
  const ctx: EmitCtx = { out: [], sets: [], sel, warnings: [] };
  const totalLength = emit(rec.root as Node, 0, [], '', ROOT_INHERITED, ctx);
  return { fields: ctx.out, totalLength, sets: ctx.sets };
}

export function parseCopybook(text: string): Copybook {
  const warnings: string[] = [];
  const roots: Node[] = [];
  const stack: Node[] = [];

  for (const stmt of splitStatements(normalizeSource(text))) {
    const node = parseStatement(stmt, warnings);
    if (!node) {
      continue;
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  const records: CopyRecord[] = [];
  for (const root of roots) {
    // 01 层的 REDEFINES 是同一区域的另一种记录定义，作为独立的 01 记录处理
    const ctx: EmitCtx = { out: [], sets: [], sel: {}, warnings };
    const totalLength = emit(root, 0, [], '', ROOT_INHERITED, ctx);
    if (ctx.out.length > 0) {
      records.push({ name: root.name, fields: ctx.out, totalLength, sets: ctx.sets, root });
    }
  }
  const first = records[0];
  return { fields: first?.fields ?? [], totalLength: first?.totalLength ?? 0, records, warnings };
}
