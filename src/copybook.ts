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
}

export interface Copybook {
  fields: CopyField[];
  totalLength: number;
  warnings: string[];
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
  'BINARY', 'PACKED-DECIMAL', 'DISPLAY', 'OCCURS', 'REDEFINES', 'SIGN', 'SYNC', 'SYNCHRONIZED',
  'JUSTIFIED', 'JUST', 'BLANK', 'EXTERNAL', 'GLOBAL', 'INDEXED',
]);

const USAGE_WORDS = new Set([
  'COMP', 'COMP-1', 'COMP-2', 'COMP-3', 'COMP-4', 'COMP-5', 'BINARY', 'PACKED-DECIMAL', 'DISPLAY',
]);

function normalizeSource(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\t/g, '    '));
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  // 固定格式的 1~6 列要么全空格，要么全是序号数字（避免把缩进 4 格的自由格式误判成固定格式）
  const fixedLike = nonEmpty.filter((l) => /^(?: {6}|\d{6})[ *\/\-D]/.test(l)).length;
  // 必须所有非空行都符合才按固定格式处理；只要有一行不符合就当自由格式，宁可保守
  const fixed = nonEmpty.length > 0 && fixedLike === nonEmpty.length;

  const out: string[] = [];
  for (const raw of lines) {
    if (fixed) {
      if (raw.length < 7) {
        continue;
      }
      const indicator = raw[6];
      if (indicator === '*' || indicator === '/' || indicator === 'D') {
        continue;
      }
      out.push(raw.slice(7, 72));
    } else {
      const t = raw.trim();
      if (t.startsWith('*')) {
        continue;
      }
      const c = t.indexOf('*>');
      out.push(c >= 0 ? t.slice(0, c) : t);
    }
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
  type: FieldType;
  signed: boolean;
}

export function picInfo(pic: string, usage: string, signSeparate: boolean): PicInfo {
  const up = pic.toUpperCase();
  const signed = up.startsWith('S');
  let len = 0;
  let digits = 0;
  let numeric = true;
  const re = /(CR|DB|[A-Z0-9.,+\-*$\/])(?:\((\d+)\))?/g;
  for (const m of up.matchAll(re)) {
    const sym = m[1];
    const n = m[2] ? parseInt(m[2], 10) : 1;
    if (sym === 'S' || sym === 'V' || sym === 'P') {
      continue;
    }
    len += n * (sym === 'CR' || sym === 'DB' ? 2 : 1);
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
      return { length: digits <= 4 ? 2 : digits <= 9 ? 4 : 8, digits, type: 'bin', signed };
    case 'COMP-3':
    case 'PACKED-DECIMAL':
      return { length: Math.ceil((digits + 1) / 2), digits, type: 'bin', signed };
    case 'COMP-1':
      return { length: 4, digits, type: 'bin', signed };
    case 'COMP-2':
      return { length: 8, digits, type: 'bin', signed };
    default:
      return {
        length: len + (signed && signSeparate ? 1 : 0),
        digits,
        type: numeric ? 'num' : 'alnum',
        signed,
      };
  }
}

function parseStatement(stmt: string, warnings: string[]): Node | undefined {
  const tokens = stmt.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s]+/g);
  if (!tokens || tokens.length === 0 || !/^\d{1,2}$/.test(tokens[0])) {
    return undefined;
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
      node.usage = up(i) || 'DISPLAY';
      i++;
    } else if (USAGE_WORDS.has(k)) {
      node.usage = k;
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
      warnings.push(`${node.name}: OCCURS DEPENDING ON 按最大次数展开`);
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
    warnings.push(`${node.name}: REDEFINES ${node.redefines} 已忽略（不占位置）`);
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

  const fields: CopyField[] = [];
  let total = 0;
  if (roots.length > 1) {
    warnings.push(`copybook 含 ${roots.length} 个顶层定义，只使用第一个（${roots[0].name}）`);
  }
  if (roots.length > 0) {
    total = flatten(roots[0], 0, '', fields, warnings);
  }
  return { fields, totalLength: total, warnings };
}
