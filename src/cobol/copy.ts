/** COPY / REPLACE 语句（NetCOBOL 文法書 7.1、7.2）：解析、REPLACING 等替换、递归展开。 */
import { t, MessageKey } from '../i18n';
import { CopyIssue } from './types';
import { LEVEL_RE } from './statement';
import { normalizeSource, splitStatements } from './source';

/** 原文语：词、字面量，以及分隔符 ( ) 和句点（空格、分隔用的逗号 / 分号不算） */
interface TextWord {
  text: string;
  start: number;
  end: number;
  literal: boolean;
}

const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

/** 把源码切成原文语，保留在原文中的位置（替换时原样保留没有被替换的部分） */
function textWords(src: string): TextWord[] {
  const out: TextWord[] = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if ((ch === ',' || ch === ';') && isSpace(src[i + 1])) {
      i++;
      continue;
    }
    if (ch === '(' || ch === ')' || (ch === '.' && isSpace(src[i + 1]))) {
      out.push({ text: ch, start: i, end: i + 1, literal: false });
      i++;
      continue;
    }
    // 字面量：'…'、"…"，以及 X'…'、N'…'、NC'…' 等
    const m = /^(?:[A-Za-z]{1,2})?(['"])/.exec(src.slice(i, i + 3));
    if (m) {
      const q = m[1];
      let j = i + m[0].length;
      for (; j < n; j++) {
        if (src[j] === q) {
          if (src[j + 1] === q) {
            j++;
            continue;
          }
          break;
        }
      }
      const end = Math.min(n, j + 1);
      out.push({ text: src.slice(i, end), start: i, end, literal: true });
      i = end;
      continue;
    }
    let j = i;
    while (
      j < n &&
      !isSpace(src[j]) &&
      src[j] !== '(' &&
      src[j] !== ')' &&
      src[j] !== '"' &&
      src[j] !== "'" &&
      !((src[j] === '.' || src[j] === ',' || src[j] === ';') && isSpace(src[j + 1]))
    ) {
      j++;
    }
    j = Math.max(j, i + 1);
    out.push({ text: src.slice(i, j), start: i, end: j, literal: false });
    i = j;
  }
  return out;
}

/** 原文语是否一致：词不区分大小写，字面量要完全一致 */
function sameWord(a: TextWord, b: TextWord): boolean {
  return a.literal || b.literal ? a.text === b.text : a.text.toUpperCase() === b.text.toUpperCase();
}

/** 替换规则：BY 左边的原文语序列 → 右边的文字 */
interface ReplaceRule {
  from: TextWord[];
  to: string;
}

/**
 * 按 REPLACING / REPLACE 的规则替换：从每个原文语开始，按规则的顺序比较，一致的部分换成右边的文字。
 * 没有被替换的部分（含空白）原样保留。
 */
function applyReplacing(src: string, rules: ReplaceRule[]): string {
  if (rules.length === 0) {
    return src;
  }
  const words = textWords(src);
  let out = '';
  let last = 0;
  for (let i = 0; i < words.length; ) {
    const rule = rules.find((r) => r.from.length > 0 && r.from.every((w, k) => i + k < words.length && sameWord(words[i + k], w)));
    if (!rule) {
      i++;
      continue;
    }
    out += src.slice(last, words[i].start) + rule.to;
    last = words[i + rule.from.length - 1].end;
    i += rule.from.length;
  }
  return out + src.slice(last);
}

/** DISJOINING 语-3 JOINING 语-4 AS PREFIX / SUFFIX：替换原文语的前缀（到第一个连字符为止）或后缀 */
interface AffixRule {
  from: string;
  to: string;
  kind: 'PREFIX' | 'SUFFIX';
}

function applyAffixes(src: string, rules: AffixRule[]): string {
  if (rules.length === 0) {
    return src;
  }
  let out = '';
  let last = 0;
  for (const w of textWords(src)) {
    if (w.literal) {
      continue;
    }
    const up = w.text.toUpperCase();
    for (const r of rules) {
      const from = r.from.toUpperCase();
      let replaced: string | undefined;
      if (r.kind === 'PREFIX' && up.startsWith(from + '-') && up.length > from.length + 1) {
        replaced = r.to + w.text.slice(r.from.length);
      } else if (r.kind === 'SUFFIX' && up.endsWith('-' + from) && up.length > from.length + 1) {
        replaced = w.text.slice(0, w.text.length - r.from.length) + r.to;
      }
      if (replaced !== undefined) {
        out += src.slice(last, w.start) + replaced;
        last = w.end;
        break;
      }
    }
  }
  return out + src.slice(last);
}

/** COPY / REPLACE 语句的词：伪文本 ==…== 作为一个整体（pseudo 为其中的原文） */
interface StmtToken {
  text: string;
  pseudo?: string;
  literal?: boolean;
}

function statementTokens(stmt: string): StmtToken[] | undefined {
  const out: StmtToken[] = [];
  const re = /==([\s\S]*?)==/g;
  let last = 0;
  for (const m of stmt.matchAll(re)) {
    textWords(stmt.slice(last, m.index)).forEach((w) => out.push({ text: w.text, literal: w.literal }));
    out.push({ text: m[0], pseudo: m[1] });
    last = m.index! + m[0].length;
  }
  const rest = stmt.slice(last);
  if (rest.includes('==')) {
    return undefined; // 伪文本没有闭合
  }
  textWords(rest).forEach((w) => out.push({ text: w.text, literal: w.literal }));
  return out;
}

const unquote = (s: string) => s.replace(/^(['"])([\s\S]*)\1$/, '$2');

/** 读取 REPLACING / REPLACE 的作用对象对：左边 BY 右边 … ；无法解析时返回 undefined */
function readRules(tokens: StmtToken[], i: number): { rules: ReplaceRule[]; next: number } | undefined {
  const rules: ReplaceRule[] = [];
  const up = (k: number) => (tokens[k]?.pseudo === undefined ? (tokens[k]?.text ?? '').toUpperCase() : '');
  while (i < tokens.length) {
    // 左边：伪文本，或到 BY 为止的一串词（一意名可以带 OF / IN 限定和下标）
    let from: TextWord[];
    if (tokens[i].pseudo !== undefined) {
      from = textWords(tokens[i].pseudo!);
      i++;
    } else {
      const parts: string[] = [];
      while (i < tokens.length && up(i) !== 'BY') parts.push(tokens[i++].text);
      from = textWords(parts.join(' '));
    }
    if (up(i) !== 'BY' || from.length === 0) {
      return undefined;
    }
    i++;
    // 右边：伪文本，或一个词 / 字面量（可以带 OF / IN 限定和下标）
    let to: string;
    if (tokens[i]?.pseudo !== undefined) {
      to = tokens[i].pseudo!.trim();
      i++;
    } else if (i < tokens.length) {
      const parts = [tokens[i++].text];
      while (up(i) === 'OF' || up(i) === 'IN') {
        parts.push(tokens[i].text, tokens[i + 1]?.text ?? '');
        i += 2;
      }
      if (tokens[i]?.text === '(') {
        while (i < tokens.length && tokens[i].text !== ')') parts.push(tokens[i++].text);
        if (i < tokens.length) parts.push(tokens[i++].text);
      }
      to = parts.join(' ');
    } else {
      return undefined;
    }
    rules.push({ from, to });
  }
  return { rules, next: i };
}

interface CopyStatement {
  name: string;
  library?: string;
  rules: ReplaceRule[];
  affixes: AffixRule[];
  /** formLib=画面 / 帐票定义（XMDLIB / XFDLIB），不是文本；syntax=无法解析 */
  problem?: 'formLib' | 'syntax';
}

/** 解析 COPY 语句（不是 COPY 语句时返回 undefined） */
function parseCopyStatement(stmt: string): CopyStatement | undefined {
  if (!/^COPY\s/i.test(stmt) && stmt.toUpperCase() !== 'COPY') {
    return undefined;
  }
  const tokens = statementTokens(stmt);
  const name = tokens && tokens[1] && tokens[1].pseudo === undefined ? unquote(tokens[1].text) : '';
  const cs: CopyStatement = { name, rules: [], affixes: [] };
  if (!tokens || !name) {
    cs.problem = 'syntax';
    return cs;
  }
  const up = (k: number) => (tokens[k]?.pseudo === undefined ? (tokens[k]?.text ?? '').toUpperCase() : '');
  let i = 2;
  if (up(i) === 'OF' || up(i) === 'IN') {
    cs.library = unquote(tokens[i + 1]?.text ?? '');
    i += 2;
    if (/^(XMDLIB|XFDLIB)$/i.test(cs.library)) {
      cs.problem = 'formLib';
      return cs;
    }
  }
  while (i < tokens.length) {
    const k = up(i);
    if (k === 'SUPPRESS') {
      i++;
    } else if (k === 'REPLACING') {
      const r = readRules(tokens, i + 1);
      if (!r) {
        cs.problem = 'syntax';
        return cs;
      }
      cs.rules.push(...r.rules);
      i = r.next;
    } else if (k === 'DISJOINING' && up(i + 2) === 'JOINING' && up(i + 4) === 'AS' && (up(i + 5) === 'PREFIX' || up(i + 5) === 'SUFFIX')) {
      cs.affixes.push({ from: tokens[i + 1].text, to: tokens[i + 3].text, kind: up(i + 5) as 'PREFIX' | 'SUFFIX' });
      i += 6;
    } else {
      // 后面出现层级号：多半是缺少句点的 COPY 与下一个数据描述项连在了一起，交给普通语句处理（字段不丢失）
      if (tokens.slice(i).some((tk) => tk.pseudo === undefined && LEVEL_RE.test(tk.text))) {
        return undefined;
      }
      cs.problem = 'syntax';
      return cs;
    }
  }
  return cs;
}

/** REPLACE 语句：OFF，或替换规则；不是 REPLACE 语句时返回 undefined */
function parseReplaceStatement(stmt: string): { off: true } | { rules: ReplaceRule[] } | { problem: true } | undefined {
  if (!/^REPLACE\s/i.test(stmt)) {
    return undefined;
  }
  const tokens = statementTokens(stmt);
  if (!tokens) {
    return { problem: true };
  }
  let i = 1;
  if ((tokens[1]?.text ?? '').toUpperCase() === 'ALSO') i++;
  if (tokens.length === 2 && tokens[1].text.toUpperCase() === 'OFF') {
    return { off: true };
  }
  const r = readRules(tokens, i);
  return r && r.rules.length > 0 ? { rules: r.rules } : { problem: true };
}

/** 被 COPY 引用的登録集原文 */
export interface CopyMember {
  text: string;
  /** 显示用的来源（文件名等） */
  source: string;
  /** 找到多个同名文件时，没有使用的其他候选 */
  others?: string[];
}

/** 按原文名（和登録集名）取得登録集原文；找不到时返回 undefined */
export type MemberResolver = (name: string, library?: string) => CopyMember | undefined;

export interface ParseOptions {
  resolve?: MemberResolver;
}

/** 源码中的 COPY 语句引用的原文名（不含画面 / 帐票定义），用来事先读取文件 */
export function copyReferences(text: string): Array<{ name: string; library?: string }> {
  const out: Array<{ name: string; library?: string }> = [];
  for (const st of splitStatements(normalizeSource(text, []), [])) {
    const c = parseCopyStatement(st);
    if (c && c.name && c.problem !== 'formLib') {
      out.push({ name: c.name, library: c.library });
    }
  }
  return out;
}

/** 展开后的语句；copy 为没有展开的 COPY（及原因） */
interface Statement {
  text: string;
  copy?: { name: string; reason: string };
}

const MAX_COPY_DEPTH = 16;

export function pushIssue(issues: CopyIssue[], issue: CopyIssue): void {
  if (!issues.some((x) => x.level === issue.level && x.text === issue.text)) {
    issues.push(issue);
  }
}

/** 把（已规范化的）源码切成语句，并递归展开其中的 COPY */
export function expandStatements(src: string, opts: ParseOptions, issues: CopyIssue[], chain: string[]): Statement[] {
  const out: Statement[] = [];
  for (const st of splitStatements(src, issues)) {
    const c = parseCopyStatement(st);
    if (!c) {
      out.push({ text: st });
      continue;
    }
    const skip = (key: MessageKey) => out.push({ text: st, copy: { name: c.name, reason: t(key, { member: c.name }) } });
    if (c.problem === 'formLib') {
      skip('cpy.copyFormLib');
      continue;
    }
    if (c.problem === 'syntax') {
      skip('cpy.copySyntax');
      continue;
    }
    const key = c.name.toUpperCase();
    if (chain.includes(key) || chain.length >= MAX_COPY_DEPTH) {
      skip('cpy.copyCycle');
      continue;
    }
    const m = opts.resolve?.(c.name, c.library);
    if (!m) {
      skip('cpy.copyNotFound');
      continue;
    }
    pushIssue(issues, { level: 'info', text: t('cpy.copyExpanded', { member: c.name, source: m.source }) });
    if (m.others && m.others.length > 0) {
      pushIssue(issues, { level: 'note', text: t('cpy.copyAmbiguous', { member: c.name, source: m.source, others: m.others.join(t('list.sep')) }) });
    }
    // 登録集原文按它自己的格式（固定 / 可变 / 自由）规范化，再做 REPLACING 等替换
    const body = applyAffixes(applyReplacing(normalizeSource(m.text, issues), c.rules), c.affixes);
    out.push(...expandStatements(body, opts, issues, [...chain, key]));
  }
  return out;
}

/** REPLACE 语句：在 COPY 展开之后，替换其后的语句，直到下一个 REPLACE 或 REPLACE OFF */
export function applyReplaceStatements(stmts: Statement[], issues: CopyIssue[]): Statement[] {
  let rules: ReplaceRule[] = [];
  const out: Statement[] = [];
  for (const st of stmts) {
    const r = st.copy ? undefined : parseReplaceStatement(st.text);
    if (r) {
      if ('problem' in r) {
        pushIssue(issues, { level: 'layout', text: t('cpy.replace'), from: 0 });
        rules = [];
      } else if ('off' in r) {
        rules = [];
      } else if (r.rules.some((x) => x.from.some((w) => w.text === '.'))) {
        // 跨语句的替换（左边含句点）无法处理
        pushIssue(issues, { level: 'layout', text: t('cpy.replace'), from: 0 });
        rules = [];
      } else {
        rules = r.rules;
        pushIssue(issues, { level: 'info', text: t('cpy.replaceApplied') });
      }
      continue;
    }
    out.push(rules.length > 0 && !st.copy ? { text: applyReplacing(st.text, rules) } : st);
  }
  return out;
}
