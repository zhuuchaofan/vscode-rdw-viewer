/**
 * 简易 COBOL copybook 解析器：把 copybook 展开成「叶子字段」列表（名称、偏移、长度、类型）。
 *
 * 支持：
 *  - 固定格式（第 7 列注释 / 续行，第 8~72 列）、可变格式（第 8 列到行尾）和自由格式
 *  - 固定 / 可变格式的续行（第 7 列为 -）：词、PIC 字符串、文字字面量
 *  - 层级号 01~49、77，FILLER，GROUP
 *  - PIC X/A/9/S/V/Z/N/G 等及 (n) 重复
 *  - USAGE DISPLAY / COMP / COMP-3 / COMP-5 / COMP-1 / COMP-2 / BINARY-CHAR 等；组项目的 USAGE、SIGN、SYNC 由下级项目继承
 *  - SIGN [LEADING|TRAILING] SEPARATE（符号占 1 字节）
 *  - OCCURS n（展开为 name(1)、嵌套时 name(1,2)…）
 *  - REDEFINES：原项目与重定义项目共用同一区域（大小取最大者），可切换显示哪一个布局
 *  - 多个 01：按记录长度选用；同长度的多个 01 也可切换；01 TYPEDEF 不作为记录
 *
 * 不支持的写法不会静默跳过，而是作为「问题」报告（CopyIssue），并区分影响程度：
 *  - layout：可能改变字段的位置或长度（未展开的 COPY、SYNC 需要的填充、OCCURS DEPENDING ON 之后的字段、
 *            无法识别的子句等）。该位置之后的字段标为「可疑」，整个布局标为不可信。
 *  - value：位置可靠，但数值的解释可能不对（PIC 中的 P 等）。
 *  - note：不影响已显示的字段（记录之外的 COPY 等）。
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
  /**
   * 小数位数：V 之后的位数。PIC 中有 P 时：P 在左边（PP99 / VPP99）为 P 和 9 的个数之和；
   * P 在右边（99PP）为负数，表示末尾补 0
   */
  scale: number;
  /** PIC 中 9 的个数（数值项目的位数） */
  digits: number;
  /** 符号单独占 1 字节（SIGN SEPARATE） */
  signSeparate: boolean;
  /** 符号在前（SIGN LEADING）；默认在后 */
  signLeading: boolean;
  /** 位于无法准确计算位置的定义之后：位置、长度可能与实际不同 */
  suspect?: boolean;
}

/** 问题的影响程度：layout=位置 / 长度可能不对；value=数值解释可能不对；note=不影响已显示的字段 */
export type IssueLevel = 'layout' | 'value' | 'note';

export interface CopyIssue {
  level: IssueLevel;
  text: string;
  /** layout 问题：从记录中的这个偏移（从 0 开始）起，字段的位置可能不对 */
  from?: number;
}

/** 布局的可信度：ok=有依据；partial=位置可靠但有未支持的语义；untrusted=位置可能不对 */
export type Trust = 'ok' | 'partial' | 'untrusted';

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
  /** 这个布局的问题（含整个 copybook 层面的问题） */
  issues: CopyIssue[];
  trust: Trust;
}

/** REDEFINES 的选择：区域 id → 布局名 */
export type LayoutSelection = Record<string, string>;

/** copybook 中的一个顶层（01）记录定义（fields / totalLength / sets / issues 为默认布局） */
export interface CopyRecord extends CopyLayout {
  name: string;
  /** 解析树（内部使用） */
  readonly root: unknown;
  /** 整个 copybook 层面的问题（内部使用，展开布局时并入 issues） */
  readonly fileIssues: CopyIssue[];
}

export interface Copybook {
  /** 第一个顶层记录的字段（便于只有一个 01 的常见情况） */
  fields: CopyField[];
  totalLength: number;
  /** 所有顶层记录；有多个 01 时可按记录长度选用 */
  records: CopyRecord[];
  /** 所有问题的文字（整个 copybook 层面 + 各记录的默认布局，去重） */
  warnings: string[];
  /** 整个 copybook 层面的问题（不属于某个记录） */
  issues: CopyIssue[];
}

/** 选用总长度等于记录长度的顶层定义；没有则用第一个 */
export function selectRecord(cb: Copybook, bodyLen: number): CopyRecord | undefined {
  return cb.records.find((r) => r.totalLength === bodyLen) ?? cb.records[0];
}

interface NodeIssue {
  level: IssueLevel;
  text: string;
}

interface Node {
  level: number;
  name: string;
  pic?: string;
  /** 本项目写明的 USAGE（未写时继承上级） */
  usage?: string;
  /** BINARY-CHAR 等 int 型是否有符号 */
  intSigned?: boolean;
  occurs: number;
  /** OCCURS DEPENDING ON（按最大次数 occurs 展开） */
  odo: boolean;
  redefines?: string;
  /** 本项目写明的 SIGN 子句（未写时继承上级） */
  sign?: { separate: boolean; leading: boolean };
  sync: boolean;
  /** 01 TYPEDEF：类型定义，不是记录 */
  typedef: boolean;
  /** 不对应数据的占位：记录中途无法处理的语句（COPY 等），只用来在该位置报告问题 */
  marker: boolean;
  /** 解析这一项时发现的问题（展开时在该项的位置报告） */
  issues: NodeIssue[];
  children: Node[];
}

/** 从上级继承的属性 */
interface Inherited {
  usage: string;
  sign: { separate: boolean; leading: boolean };
  /** 组项目上的 SYNC 适用于下级的基本项目（NetCOBOL 的 Windows / Linux 版） */
  sync: boolean;
}

/** int 型二进制整数（NetCOBOL）的字节数 */
const INT_SIZES: Record<string, number> = { 'BINARY-CHAR': 1, 'BINARY-SHORT': 2, 'BINARY-LONG': 4, 'BINARY-DOUBLE': 8 };

const NO_PIC_USAGES = new Set(['COMP-1', 'COMP-2', 'INDEX', 'POINTER', ...Object.keys(INT_SIZES)]);

const USAGE_WORDS = new Set([
  'COMP', 'COMP-1', 'COMP-2', 'COMP-3', 'COMP-4', 'COMP-5', 'BINARY', 'PACKED-DECIMAL', 'DISPLAY',
  'NATIONAL', 'DISPLAY-1', 'INDEX', 'POINTER', 'BIT', ...Object.keys(INT_SIZES),
]);

/** 子句开头的词：用来判断层级号后面是不是数据名，以及跳过名字列表（INDEXED BY 等）时在哪里停 */
const CLAUSE_STARTS = new Set([
  'PIC', 'PICTURE', 'USAGE', 'OCCURS', 'REDEFINES', 'SIGN', 'LEADING', 'TRAILING', 'SYNC', 'SYNCHRONIZED',
  'JUSTIFIED', 'JUST', 'BLANK', 'EXTERNAL', 'GLOBAL', 'VALUE', 'VALUES', 'INDEXED', 'ASCENDING', 'DESCENDING',
  'DEPENDING', 'CHARACTER', 'PRINTING', 'BASED', 'TYPE', 'TYPEDEF',
  'COMPUTATIONAL', 'COMPUTATIONAL-1', 'COMPUTATIONAL-2', 'COMPUTATIONAL-3', 'COMPUTATIONAL-4', 'COMPUTATIONAL-5',
  ...USAGE_WORDS,
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

function columnsOf(s: string): number {
  let n = 0;
  for (const ch of s) {
    n += columnWidth(ch);
  }
  return n;
}

/** 固定格式行：1~6 列为空格或序号数字，第 7 列为指示区 */
const FIXED_LINE = /^(?: {6}|\d{6})[ *\/\-Dd$]/;
/** 固定格式的 B 区域到第 72 列为止：第 8~72 列共 65 列 */
const FIXED_AREA = 65;

/**
 * 从 s 开头按引号状态 q 扫描：返回结束时的引号状态，以及字面量之外的行内注释「*>」的位置（没有则 -1）。
 * 字面量中的两个连续引号（表示一个引号）会自然地关闭再打开，不需要特别处理。
 */
function scanQuotes(s: string, q: string): { q: string; comment: number } {
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = '';
    } else if (ch === '"' || ch === "'") {
      q = ch;
    } else if (ch === '*' && s[i + 1] === '>') {
      return { q, comment: i };
    }
  }
  return { q, comment: -1 };
}

/**
 * 去掉注释、序号区（1~6 列）、标识区（固定格式的 73~80 列），处理续行，返回拼接后的源码。
 * 逐行判断：以 6 位序号开头的行、或文件大多数行都是固定格式时符合固定格式的行，按固定 / 可变格式处理；
 * 其余行按自由格式处理。这样一两行格式不规整也不会让整个文件解析失败。
 * 有一行在第 80 列之后还有内容时（固定格式一行最多 80 列），按可变格式处理：内容到行尾，不截掉第 73 列以后。
 */
function normalizeSource(text: string, issues: CopyIssue[]): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/\t/g, '    '));
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const fixedLike = nonEmpty.filter((l) => FIXED_LINE.test(l)).length;
  const mostlyFixed = nonEmpty.length > 0 && fixedLike * 2 >= nonEmpty.length;
  const isFixed = (raw: string) => /^\d{6}/.test(raw) || (mostlyFixed && FIXED_LINE.test(raw));
  // 注释行的内容任意，不作为判断依据
  const variable = lines.some((l) => isFixed(l) && !'*/Dd'.includes(l[6]) && sliceColumns(l, 80, Infinity).trim() !== '');
  const areaEnd = variable ? Infinity : 72;

  /** 已经处理好的各行（续行合并到前一行） */
  const parts: string[] = [];
  /** 最后一行结束时的引号状态（字面量没有闭合时为引号字符） */
  let quote = '';
  /** 最后一个物理行在 B 区域中占的列数（字面量续行时用来补齐到第 72 列） */
  let lastCols = 0;
  /** 把 text 接到 base 之后（从引号状态 q 开始），去掉字面量之外的行内注释 */
  const append = (base: string, text: string, q: string) => {
    const r = scanQuotes(text, q);
    parts.push(base + (r.comment >= 0 ? text.slice(0, r.comment) : text));
    quote = r.comment >= 0 ? '' : r.q;
  };

  for (const raw of lines) {
    if (!isFixed(raw)) {
      const content = raw.trim();
      if (content.startsWith('*')) {
        continue;
      }
      append('', content, '');
      lastCols = columnsOf(content);
      continue;
    }
    const indicator = raw[6] ?? ' ';
    if (indicator === '*' || indicator === '/' || indicator === 'D' || indicator === 'd') {
      continue;
    }
    const content = sliceColumns(raw, 7, areaEnd); // 第 8 列起（按字节计）
    if (indicator !== '-') {
      if (content.trim() === '') {
        continue; // 空行不影响续行的接续对象
      }
      append('', content, '');
      lastCols = columnsOf(content);
      continue;
    }
    // 续行：接在前一行（注释行、空行除外）的后面
    if (parts.length === 0) {
      issues.push({ level: 'note', text: t('cpy.contNoPrev') });
      append('', content, '');
      lastCols = columnsOf(content);
      continue;
    }
    const prev = parts.pop()!;
    let cont = content.trimStart();
    if (quote) {
      // 字面量的续行：前一行到 B 区域末尾的空格都属于字面量，续行从引号之后接上
      const pad = variable ? '' : ' '.repeat(Math.max(0, FIXED_AREA - lastCols));
      if (cont[0] === quote) {
        cont = cont.slice(1);
      } else {
        issues.push({ level: 'layout', text: t('cpy.contNoQuote'), from: 0 });
      }
      append(prev + pad, cont, quote);
    } else {
      // 词、PIC 字符串的续行：前一行最后一个非空字符之后直接接上
      append(prev.trimEnd(), cont, '');
    }
    lastCols = columnsOf(content);
  }
  return parts.join(' ');
}

function splitStatements(src: string, issues: CopyIssue[]): string[] {
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
  if (quote) {
    // 引号没有闭合：后面的定义都被当作字面量吞掉了
    issues.push({ level: 'layout', text: t('cpy.unclosedQuote'), from: 0 });
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

/** PIC 的一个符号及可选的重复次数；\ 和 ¥ 是日文环境的货币符号 */
const PIC_SYMBOL = /(CR|DB|[A-Z0-9.,+\-*$\/\\¥])(?:\((\d+)\))?/g;

/** PIC 字符串能被完整地解析（没有多余的括号等） */
function validPic(pic: string): boolean {
  return pic.length > 0 && pic.toUpperCase().replace(PIC_SYMBOL, '') === '';
}

export function picInfo(pic: string, usage: string, signSeparate: boolean, intSigned = true): PicInfo {
  const up = pic.toUpperCase();
  const signed = up.startsWith('S');
  let len = 0;
  let digits = 0;
  let numeric = true;
  let scale = 0;
  let afterV = false;
  /** P（假想的数位，不占存储）：在数字左边的个数、在数字右边的个数 */
  let leadingP = 0;
  let trailingP = 0;
  for (const m of up.matchAll(PIC_SYMBOL)) {
    const sym = m[1];
    const n = m[2] ? parseInt(m[2], 10) : 1;
    if (sym === 'V') {
      afterV = true;
      continue;
    }
    if (sym === 'P') {
      if (digits === 0) leadingP += n;
      else trailingP += n;
      continue;
    }
    if (sym === 'S') {
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
  // P 在左边：假想小数点在所有 P 的左边（PP99 的 12 表示 0.0012）；P 在右边：末尾补 0（99PP 的 12 表示 1200）
  if (leadingP > 0) {
    scale = leadingP + digits;
  } else if (trailingP > 0) {
    scale = -trailingP;
  }

  if (usage in INT_SIZES) {
    return { length: INT_SIZES[usage], digits: 0, scale: 0, type: 'bin', signed: intSigned };
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
/** 可以安静跳过的、与数据布局无关的语句 */
const IGNORABLE = new Set(['EJECT', 'SKIP1', 'SKIP2', 'SKIP3', 'TITLE']);

/** 不带层级号的语句（COPY 等）：在出现的位置报告 */
interface Directive {
  kind: 'copy' | 'replace' | 'unknown';
  /** COPY 的成员名 / 语句开头 */
  text: string;
}

function newNode(level: number): Node {
  return { level, name: 'FILLER', occurs: 1, odo: false, sync: false, typedef: false, marker: false, issues: [], children: [] };
}

function parseStatement(stmt: string): Node | Directive | undefined {
  let tokens: string[] = stmt.match(/'(?:[^']|'')*'|"(?:[^"]|"")*"|[^\s]+/g) ?? [];
  if (tokens.length === 0) {
    return undefined;
  }
  let prefix = '';
  if (!LEVEL_RE.test(tokens[0])) {
    const word = tokens[0].toUpperCase();
    if (IGNORABLE.has(word)) {
      return undefined;
    }
    const at = tokens.findIndex((tk) => LEVEL_RE.test(tk));
    // 整句都没有层级号：COPY / REPLACE 语句，或无法识别的语句
    if (at < 0) {
      if (word === 'COPY') {
        return { kind: 'copy', text: (tokens[1] ?? '').replace(/^['"]|['"]$/g, '') };
      }
      return word === 'REPLACE' ? { kind: 'replace', text: stmt.slice(0, 40) } : { kind: 'unknown', text: stmt.slice(0, 40) };
    }
    // 层级号前面有无法识别的内容（可能是缺少句点的 COPY 等）
    prefix = tokens.slice(0, at).join(' ').slice(0, 30);
    tokens = tokens.slice(at);
  }
  const level = parseInt(tokens[0], 10);
  if (level === 66 || level === 88) {
    return undefined;
  }

  const node = newNode(level === 77 ? 1 : level);
  let i = 1;
  if (tokens[1] && !CLAUSE_STARTS.has(tokens[1].toUpperCase().replace(/,$/, ''))) {
    node.name = tokens[1];
    i = 2;
  }
  if (prefix) {
    node.issues.push({ level: 'layout', text: t('cpy.unknownPrefix', { text: prefix }) });
  }

  const up = (idx: number): string => (tokens[idx] ?? '').toUpperCase().replace(/[,;]$/, '');
  /** 跳过指定的词（可选的 IS、ON 等） */
  const skipWords = (...words: string[]) => {
    while (i < tokens.length && words.includes(up(i))) i++;
  };
  /** 跳过名字列表（INDEXED BY 的指标名等），到下一个子句为止 */
  const skipNames = () => {
    while (i < tokens.length && !CLAUSE_STARTS.has(up(i))) i++;
  };
  let unknownWord: string | undefined;

  while (i < tokens.length) {
    const k = normalizeUsage(up(i));
    if (k === '' || k === 'IS') {
      i++;
    } else if (k === 'PIC' || k === 'PICTURE') {
      i++;
      skipWords('IS');
      node.pic = (tokens[i] ?? '').replace(/[,;]$/, '').toUpperCase();
      i++;
      if (!validPic(node.pic)) {
        node.issues.push({ level: 'layout', text: t('cpy.badPic', { name: node.name, pic: node.pic }) });
      }
    } else if (k === 'USAGE') {
      i++;
      skipWords('IS');
      const u = normalizeUsage(up(i) || 'DISPLAY');
      i++;
      if (!USAGE_WORDS.has(u)) {
        node.issues.push({ level: 'layout', text: t('cpy.unknownUsage', { name: node.name, usage: u }) });
      }
      node.usage = u;
      if (u in INT_SIZES) {
        node.intSigned = u !== 'BINARY-CHAR';
        if (up(i) === 'SIGNED' || up(i) === 'UNSIGNED') node.intSigned = up(i++) === 'SIGNED';
      }
    } else if (USAGE_WORDS.has(k)) {
      node.usage = k;
      i++;
      if (k in INT_SIZES) {
        node.intSigned = k !== 'BINARY-CHAR';
        if (up(i) === 'SIGNED' || up(i) === 'UNSIGNED') node.intSigned = up(i++) === 'SIGNED';
      }
    } else if (k === 'OCCURS') {
      i++;
      let n = parseInt(tokens[i] ?? '', 10);
      i++;
      if (up(i) === 'TO') {
        n = parseInt(tokens[i + 1] ?? '', 10);
        i += 2;
      }
      skipWords('TIMES');
      if (Number.isFinite(n) && n > 0) {
        node.occurs = n;
      } else {
        node.issues.push({ level: 'layout', text: t('cpy.badOccurs', { name: node.name }) });
      }
    } else if (k === 'DEPENDING') {
      i++;
      skipWords('ON');
      skipNames();
      node.odo = true;
    } else if (k === 'REDEFINES') {
      node.redefines = tokens[i + 1]?.replace(/[,;]$/, '');
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
      skipWords('LEFT', 'RIGHT');
    } else if (k === 'VALUE' || k === 'VALUES') {
      i++;
      skipNames();
    } else if (k === 'BLANK') {
      i++;
      skipWords('WHEN', 'ZERO', 'ZEROS', 'ZEROES');
    } else if (k === 'JUSTIFIED' || k === 'JUST') {
      i++;
      skipWords('RIGHT');
    } else if (k === 'EXTERNAL' || k === 'GLOBAL') {
      i++;
    } else if (k === 'INDEXED') {
      i++;
      skipWords('BY');
      skipNames();
    } else if (k === 'ASCENDING' || k === 'DESCENDING') {
      i++;
      skipWords('KEY', 'IS');
      skipNames();
    } else if (k === 'CHARACTER' || k === 'PRINTING' || k === 'BASED') {
      // NetCOBOL：CHARACTER TYPE、PRINTING POSITION（印字属性）、BASED ON（基底付け）。都不影响布局
      i++;
      skipWords('TYPE', 'POSITION', 'ON', 'IS');
      skipNames();
    } else if (k === 'TYPEDEF') {
      node.typedef = true;
      i++;
      skipWords('STRONG');
    } else if (k === 'TYPE') {
      i++;
      const type = tokens[i] ?? '';
      skipNames();
      node.issues.push({ level: 'layout', text: t('cpy.type', { name: node.name, type }) });
    } else {
      unknownWord ??= tokens[i];
      i++;
    }
  }
  if (unknownWord !== undefined) {
    node.issues.push({ level: 'layout', text: t('cpy.unknownClause', { name: node.name, word: unknownWord }) });
  }
  return node;
}

const sameName = (a: string | undefined, b: string) => (a ?? '').toUpperCase() === b.toUpperCase();

function isElementary(node: Node, usage: string): boolean {
  return !!node.pic || (node.children.length === 0 && NO_PIC_USAGES.has(usage));
}

function inherit(node: Node, from: Inherited): Inherited {
  return { usage: node.usage ?? from.usage, sign: node.sign ?? from.sign, sync: node.sync || from.sync };
}

/** 同一区域的项目：原项目 + 重定义项目。orphan=REDEFINES 的对象找不到（这个项目被忽略） */
type Slot = Node[] & { orphan?: boolean };

/** 把相邻的「原项目 + 重定义项目」归为一组；重定义项目的对象可以是原项目或同组中的另一项目 */
function groupSlots(children: Node[]): Slot[] {
  const slots: Slot[] = [];
  for (const c of children) {
    const last = slots[slots.length - 1];
    if (c.redefines) {
      if (last && !last.orphan && last.some((x) => sameName(c.redefines, x.name))) {
        last.push(c);
      } else {
        slots.push(Object.assign([c], { orphan: true }));
      }
      continue;
    }
    slots.push([c]);
  }
  return slots;
}

/** SYNC 时基本项目的固有边界（字节）；SYNC 不起作用的项目为 0（NetCOBOL 文法書 5.4.12） */
function syncBoundary(usage: string, digits: number): number {
  switch (usage) {
    case 'BINARY':
    case 'COMP':
    case 'COMP-4':
    case 'COMP-5':
      return digits <= 4 ? 2 : 4;
    case 'COMP-1':
    case 'INDEX':
    case 'POINTER':
      return 4;
    case 'COMP-2':
      return 8;
    default:
      return 0;
  }
}

interface EmitCtx {
  out: CopyField[];
  sets: RedefineSet[];
  sel: LayoutSelection;
  issues: CopyIssue[];
  /** OCCURS DEPENDING ON 表的结束位置（全部展开后再判断后面有没有字段） */
  odo: Array<{ name: string; end: number }>;
}

/** 记录问题：同一问题只记一次，位置取最靠前的 */
function addIssue(ctx: EmitCtx, issue: CopyIssue): void {
  const same = ctx.issues.find((x) => x.level === issue.level && x.text === issue.text);
  if (!same) {
    ctx.issues.push({ ...issue });
  } else if (issue.from !== undefined && (same.from === undefined || issue.from < same.from)) {
    same.from = issue.from;
  }
}

/** 项目开头（第一个基本项目）要求的边界：SYNC 时为该项目的固有边界，否则为 0 */
function leadBoundary(node: Node, inh: Inherited): number {
  if (node.marker) {
    return 0;
  }
  const me = inherit(node, inh);
  if (isElementary(node, me.usage)) {
    return me.sync ? syncBoundary(me.usage, picInfo(node.pic ?? '', me.usage, me.sign.separate, node.intSigned).digits) : 0;
  }
  const first = groupSlots(node.children).find((sl) => !sl.orphan && !sl[0].marker);
  return first ? leadBoundary(first[0], me) : 0;
}

/** 项目中所有 SYNC 基本项目的边界的最大值（OCCURS 的每次重复按它补齐） */
function maxBoundary(node: Node, inh: Inherited): number {
  if (node.marker) {
    return 0;
  }
  const me = inherit(node, inh);
  if (isElementary(node, me.usage)) {
    return me.sync ? syncBoundary(me.usage, picInfo(node.pic ?? '', me.usage, me.sign.separate, node.intSigned).digits) : 0;
  }
  return Math.max(0, ...node.children.map((c) => maxBoundary(c, me)));
}

/** 编译器插入的填充字节（遊びバイト）：作为隐含的 FILLER 显示 */
function pushSlack(ctx: EmitCtx, offset: number, length: number): void {
  ctx.out.push({
    name: 'FILLER',
    pic: `X(${length})`,
    offset,
    length,
    type: 'alnum',
    signed: false,
    usage: 'DISPLAY',
    scale: 0,
    digits: 0,
    signSeparate: false,
    signLeading: false,
  });
}

/**
 * 展开一个项目，返回结束偏移。
 *
 * SYNC 的填充字节按 NetCOBOL 文法書 1.3.5.1 插入（偏移从记录开头算起，01 从 8 字节边界开始）：
 *  1. 需要对齐的项目前面是基本项目时，填充放在它的紧前面；
 *  2. 需要对齐的项目是组项目的第一个项目时，填充放在「前面是基本项目」的最内层的那个组项目前面
 *     （不计入内层组项目的大小）。leading=true 表示这个项目是所在组的第一个项目，由上层负责对齐；
 *  3. 带 OCCURS 的组项目中有需要对齐的项目时，每次重复的末尾补齐到其中最大边界的倍数。
 */
function emit(node: Node, offset: number, idx: number[], path: string, inh: Inherited, ctx: EmitCtx, leading = false): number {
  for (const is of node.issues) {
    addIssue(ctx, { ...is, from: offset });
  }
  if (node.marker) {
    return offset;
  }
  const me = inherit(node, inh);
  const elementary = isElementary(node, me.usage);
  // 已经报告过这一项的长度问题（TYPE 等）时，不再重复报告「没有 PIC」
  if (!elementary && node.children.length === 0 && !node.issues.some((x) => x.level === 'layout')) {
    addIssue(ctx, { level: 'layout', text: t('cpy.noPic', { name: node.name }), from: offset });
  }
  let off = offset;
  const lead = leadBoundary(node, inh);
  if (lead > 0 && off % lead !== 0 && (!leading || elementary)) {
    const pad = lead - (off % lead);
    pushSlack(ctx, off, pad);
    off += pad;
  }
  const repAlign = !elementary && node.occurs > 1 ? maxBoundary(node, inh) : 0;
  for (let r = 1; r <= node.occurs; r++) {
    const ix = node.occurs > 1 ? [...idx, r] : idx;
    const repStart = off;
    if (elementary) {
      const p = picInfo(node.pic ?? '', me.usage, me.sign.separate, node.intSigned);
      const picText = node.pic ?? '';
      if (me.usage === 'INDEX' || me.usage === 'POINTER') {
        addIssue(ctx, { level: 'layout', text: t('cpy.pointer', { name: node.name, usage: me.usage }), from: off });
      } else if (me.usage === 'BIT') {
        addIssue(ctx, { level: 'layout', text: t('cpy.bit', { name: node.name }), from: off });
      }
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
      const size = off - repStart;
      if (repAlign > 0 && size % repAlign !== 0) {
        const pad = repAlign - (size % repAlign);
        pushSlack(ctx, off, pad);
        off += pad;
      }
    }
  }
  if (node.odo) {
    ctx.odo.push({ name: node.name, end: off });
  }
  return off;
}

function emitChildren(children: Node[], offset: number, idx: number[], path: string, inh: Inherited, ctx: EmitCtx): number {
  let off = offset;
  /** 还没有展开任何项目：下一个项目是这个组的第一个项目 */
  let first = true;
  for (const slot of groupSlots(children)) {
    if (slot.orphan) {
      // 找不到 REDEFINES 的对象：这个项目被忽略，它可能比原项目长，区域大小因此可能不对
      addIssue(ctx, { level: 'layout', text: t('cpy.redefinesTarget', { name: slot[0].name, target: slot[0].redefines ?? '' }), from: off });
      continue;
    }
    if (slot.length === 1) {
      off = emit(slot[0], off, idx, path, inh, ctx, first);
      first &&= slot[0].marker;
      continue;
    }
    // REDEFINES：原项目按通常的规则对齐；重定义项目从同一位置开始（对齐由编写者负责，编译器不插入填充）
    const lead = first ? 0 : leadBoundary(slot[0], inh);
    if (lead > 0 && off % lead !== 0) {
      const pad = lead - (off % lead);
      pushSlack(ctx, off, pad);
      off += pad;
    }
    first = false;
    // 只展开选中的布局；区域大小取各布局实际展开后的最大值（含填充），未选中布局中的问题也会影响区域大小
    const id = `${path}.${slot[0].name}`.replace(/^\./, '');
    const chosen = slot.find((c) => sameName(ctx.sel[id], c.name)) ?? slot[0];
    // 外层区域先登记（列表按出现顺序），长度在各布局展开后确定
    let set = ctx.sets.find((x) => x.id === id);
    if (!set) {
      set = { id, base: slot[0].name, options: slot.map((c) => c.name), offset: off, length: 0 };
      ctx.sets.push(set);
    }
    let end = off;
    for (const c of slot) {
      if (c === chosen) {
        end = Math.max(end, emit(c, off, idx, path, inh, ctx, true));
        continue;
      }
      const hidden: EmitCtx = { out: [], sets: [], sel: ctx.sel, issues: [], odo: [] };
      end = Math.max(end, emit(c, off, idx, path, inh, hidden, true));
      hidden.issues.filter((x) => x.level === 'layout').forEach((x) => addIssue(ctx, { ...x, from: off }));
      hidden.odo.forEach((o) => addIssue(ctx, { level: 'layout', text: t('cpy.odoLayout', { name: o.name }), from: off }));
    }
    set.length = Math.max(set.length, end - off);
    off = end;
  }
  return off;
}

const ROOT_INHERITED: Inherited = { usage: 'DISPLAY', sign: { separate: false, leading: false }, sync: false };

function trustOf(issues: CopyIssue[]): Trust {
  if (issues.some((x) => x.level === 'layout')) return 'untrusted';
  return issues.length > 0 ? 'partial' : 'ok';
}

function buildLayout(root: Node, sel: LayoutSelection, fileIssues: CopyIssue[]): CopyLayout {
  const ctx: EmitCtx = { out: [], sets: [], sel, issues: [], odo: [] };
  const totalLength = emit(root, 0, [], '', ROOT_INHERITED, ctx, true);
  // OCCURS DEPENDING ON：后面还有字段时，那些字段的位置随实际次数变化；在记录末尾时只有超出实际次数的部分无效
  for (const o of ctx.odo) {
    if (o.end < totalLength) {
      addIssue(ctx, { level: 'layout', text: t('cpy.odoLayout', { name: o.name }), from: o.end });
    } else {
      addIssue(ctx, { level: 'value', text: t('cpy.odoTail', { name: o.name }) });
    }
  }
  fileIssues.forEach((x) => addIssue(ctx, x));
  // 第一个位置可能不对的地方之后的字段都标为可疑
  const froms = ctx.issues.filter((x) => x.level === 'layout').map((x) => x.from ?? 0);
  const firstBad = froms.length > 0 ? Math.min(...froms) : Infinity;
  for (const f of ctx.out) {
    if (f.offset >= firstBad) f.suspect = true;
  }
  return { fields: ctx.out, totalLength, sets: ctx.sets, issues: ctx.issues, trust: trustOf(ctx.issues) };
}

/** 按 REDEFINES 的选择展开一个 01 记录 */
export function layoutRecord(rec: CopyRecord, sel: LayoutSelection = {}): CopyLayout {
  return buildLayout(rec.root as Node, sel, rec.fileIssues);
}

export function parseCopybook(text: string): Copybook {
  const fileIssues: CopyIssue[] = [];
  const roots: Node[] = [];
  const stack: Node[] = [];

  for (const stmt of splitStatements(normalizeSource(text, fileIssues), fileIssues)) {
    const parsed = parseStatement(stmt);
    if (!parsed) {
      continue;
    }
    if (!('level' in parsed)) {
      const issueText =
        parsed.kind === 'copy'
          ? t('cpy.copy', { member: parsed.text })
          : parsed.kind === 'replace'
            ? t('cpy.replace')
            : t('cpy.unknownStmt', { stmt: parsed.text });
      if (parsed.kind === 'replace') {
        // REPLACE 会改写之后的源码：哪里会变无法判断
        fileIssues.push({ level: 'layout', text: issueText, from: 0 });
        continue;
      }
      // 记录定义的中途：在这个位置放一个占位项目，展开时从这里开始标为可疑
      const group = [...stack].reverse().find((n) => !n.pic);
      if (group) {
        const marker = newNode(stack[stack.length - 1].level);
        marker.marker = true;
        marker.name = parsed.kind === 'copy' ? `COPY ${parsed.text}` : '?';
        marker.issues.push({ level: 'layout', text: issueText });
        group.children.push(marker);
      } else if (stack.length > 0) {
        fileIssues.push({ level: 'layout', text: issueText, from: 0 });
      } else {
        // 记录之外：已有的记录不受影响，但可能有记录没有显示出来
        fileIssues.push({ level: 'note', text: parsed.kind === 'copy' ? t('cpy.copyOutside', { member: parsed.text }) : issueText });
      }
      continue;
    }
    const node = parsed;
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
    if (root.typedef) {
      continue; // 类型定义，不是记录
    }
    // 01 层的 REDEFINES 是同一区域的另一种记录定义，作为独立的 01 记录处理
    const layout = buildLayout(root, {}, fileIssues);
    if (layout.fields.length > 0) {
      records.push({ name: root.name, ...layout, root, fileIssues });
    }
  }
  const warnings = [...new Set([...fileIssues, ...records.flatMap((r) => r.issues)].map((x) => x.text))];
  const first = records[0];
  return { fields: first?.fields ?? [], totalLength: first?.totalLength ?? 0, records, warnings, issues: fileIssues };
}
