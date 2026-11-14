/**
 * copybook 源码的预处理：固定 / 可变 / 自由格式的判断，序号区、标识区、注释的去除，
 * 续行（第 7 列为 -）的合并，以及按句点切分语句。
 */
import { t } from '../i18n';
import { CopyIssue } from './types';

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
export function normalizeSource(text: string, issues: CopyIssue[]): string {
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

export function splitStatements(src: string, issues: CopyIssue[]): string[] {
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
