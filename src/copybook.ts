/**
 * 简易 COBOL copybook 解析器：把 copybook 展开成「叶子字段」列表（名称、偏移、长度、类型）。
 *
 * 支持：
 *  - 固定格式（第 7 列注释/第 8~72 列）和自由格式
 *  - 层级号 01~49、77，FILLER，GROUP
 *  - PIC X/A/9/S/V/Z 等及 (n) 重复
 *  - USAGE DISPLAY / COMP / COMP-3 等（二进制类只计算长度，按十六进制显示）
 *  - SIGN ... SEPARATE（符号占 1 字节）
 *  - OCCURS n（展开为 name(1), name(2)…）
 *
 * 不支持（会产生警告）：REDEFINES（被忽略，不占位置）、OCCURS DEPENDING ON（按最大次数展开）、
 * 多个 01（只使用第一个）。
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
}

/** copybook 中的一个顶层（01）记录定义 */
export interface CopyRecord {
  name: string;
  fields: CopyField[];
  totalLength: number;
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
  usage: string;
  occurs: number;
  redefines?: string;
  signSeparate: boolean;
  children: Node[];
}

const CLAUSE_STARTS = new Set([
  'PIC', 'PICTURE', 'USAGE', 'COMP', 'COMP-1', 'COMP-2', 'COMP-3', 'COMP-4', 'COMP-5',
  'BINARY', 'PACKED-DECIMAL', 'DISPLAY', 'NATIONAL', 'DISPLAY-1', 'OCCURS', 'REDEFINES',
  'COMPUTATIONAL', 'COMPUTATIONAL-1', 'COMPUTATIONAL-2', 'COMPUTATIONAL-3', 'COMPUTATIONAL-4', 'COMPUTATIONAL-5', 'SIGN', 'SYNC', 'SYNCHRONIZED',
  'JUSTIFIED', 'JUST', 'BLANK', 'EXTERNAL', 'GLOBAL', 'INDEXED',
]);

const USAGE_WORDS = new Set([
  'COMP', 'COMP-1', 'COMP-2', 'COMP-3', 'COMP-4', 'COMP-5', 'BINARY', 'PACKED-DECIMAL', 'DISPLAY',
  'NATIONAL', 'DISPLAY-1',
]);

/** COMPUTATIONAL-3 → COMP-3 等 */
function normalizeUsage(u: string): string {
  return u.replace(/^COMPUTATIONAL/, 'COMP');
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
      content = raw.slice(7, 72);
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
    usage: 'DISPLAY',
    occurs: 1,
    signSeparate: false,
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
    } else if (k === 'SIGN') {
      i++;
      while (['IS', 'LEADING', 'TRAILING', 'SEPARATE', 'CHARACTER'].includes(up(i))) {
        if (up(i) === 'SEPARATE') {
          node.signSeparate = true;
        }
        i++;
      }
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

function flatten(node: Node, offset: number, suffix: string, out: CopyField[], warnings: string[]): number {
  if (node.redefines) {
    warnings.push(t('cpy.redefines', { name: node.name, target: node.redefines }));
    return offset;
  }
  let off = offset;
  for (let r = 1; r <= node.occurs; r++) {
    const sfx = suffix + (node.occurs > 1 ? `(${r})` : '');
    if (node.pic) {
      const p = picInfo(node.pic, node.usage, node.signSeparate);
      out.push({
        name: node.name + sfx,
        pic: p.type === 'bin' ? `${node.pic} ${node.usage}` : node.pic,
        offset: off,
        length: p.length,
        type: p.type,
        signed: p.signed,
        usage: node.usage,
        scale: p.scale,
      });
      off += p.length;
    } else {
      for (const c of node.children) {
        off = flatten(c, off, sfx, out, warnings);
      }
    }
  }
  return off;
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
    const fields: CopyField[] = [];
    const total = flatten(root, 0, '', fields, warnings);
    if (fields.length > 0) {
      records.push({ name: root.name, fields, totalLength: total });
    }
  }
  const first = records[0];
  return { fields: first?.fields ?? [], totalLength: first?.totalLength ?? 0, records, warnings };
}
