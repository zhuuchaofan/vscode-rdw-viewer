/** 数据描述项（层级号 + 各子句）的解析：一个语句 → 一个解析树节点，或无法处理的语句（COPY 等）。 */
import { t } from '../i18n';
import { IssueLevel } from './types';
import { INT_SIZES, USAGE_WORDS, normalizeUsage, validPic } from './pic';

interface NodeIssue {
  level: IssueLevel;
  text: string;
}

export interface Node {
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

/** 子句开头的词：用来判断层级号后面是不是数据名，以及跳过名字列表（INDEXED BY 等）时在哪里停 */
const CLAUSE_STARTS = new Set([
  'PIC', 'PICTURE', 'USAGE', 'OCCURS', 'REDEFINES', 'SIGN', 'LEADING', 'TRAILING', 'SYNC', 'SYNCHRONIZED',
  'JUSTIFIED', 'JUST', 'BLANK', 'EXTERNAL', 'GLOBAL', 'VALUE', 'VALUES', 'INDEXED', 'ASCENDING', 'DESCENDING',
  'DEPENDING', 'CHARACTER', 'PRINTING', 'BASED', 'TYPE', 'TYPEDEF',
  'COMPUTATIONAL', 'COMPUTATIONAL-1', 'COMPUTATIONAL-2', 'COMPUTATIONAL-3', 'COMPUTATIONAL-4', 'COMPUTATIONAL-5',
  ...USAGE_WORDS,
]);

export const LEVEL_RE = /^(?:0?[1-9]|[1-4][0-9]|66|77|88)$/;

/** 可以安静跳过的、与数据布局无关的语句 */
const IGNORABLE = new Set(['EJECT', 'SKIP1', 'SKIP2', 'SKIP3', 'TITLE']);

/** 不带层级号的语句（COPY 等）：在出现的位置报告 */
export interface Directive {
  kind: 'copy' | 'replace' | 'unknown';
  /** COPY 的成员名 / 语句开头 */
  text: string;
}

export function newNode(level: number): Node {
  return { level, name: 'FILLER', occurs: 1, odo: false, sync: false, typedef: false, marker: false, issues: [], children: [] };
}

export function parseStatement(stmt: string): Node | Directive | undefined {
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
