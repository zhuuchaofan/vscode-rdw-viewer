/**
 * COPY 原文名 → 登録集原文文件 的查找规则（不依赖 VS Code，便于测试）。
 *
 * NetCOBOL 按翻译选项 / 环境变量指定的登録集目录查找；扩展无法得知这些设置，
 * 因此按以下顺序在工作区中查找：
 *  1. 引用它的 copybook 所在的目录；
 *  2. 目录名与登録集名（COPY … OF 登録集名）一致的目录；
 *  3. 工作区中其他同名文件（路径短的、按字母顺序在前的优先）。
 * 文件名不区分大小写，可以没有扩展名，或带有 .cpy / .cbl / .cob / .copy。
 */
import * as path from 'path';

export const MEMBER_EXTENSIONS = ['', '.cpy', '.cbl', '.cob', '.copy'];

/** 原文名可能对应的文件名（原样、大写、小写 × 各种扩展名） */
export function memberFileNames(name: string): string[] {
  const base = path.basename(name);
  const out = new Set<string>();
  for (const n of [base, base.toUpperCase(), base.toLowerCase()]) {
    for (const ext of MEMBER_EXTENSIONS) {
      out.add(n + ext);
      out.add(n + ext.toUpperCase());
    }
  }
  return [...out];
}

/** 文件是否对应这个原文名（不区分大小写；允许没有扩展名或常见的扩展名） */
export function matchesMember(file: string, name: string): boolean {
  const want = path.basename(name).toUpperCase();
  const got = path.basename(file).toUpperCase();
  return MEMBER_EXTENSIONS.some((ext) => got === want + ext.toUpperCase());
}

/**
 * 从候选文件中选出使用的一个。baseDir 为引用它的 copybook 所在目录，library 为登録集名。
 * 返回选中的文件和没有使用的其他候选；没有候选时返回 undefined。
 */
export function pickMember(
  name: string,
  library: string | undefined,
  candidates: string[],
  baseDir: string
): { chosen: string; others: string[] } | undefined {
  const files = [...new Set(candidates.filter((f) => matchesMember(f, name)))];
  if (files.length === 0) {
    return undefined;
  }
  const rank = (f: string): number => {
    if (path.dirname(f) === baseDir) return 0;
    if (library && path.basename(path.dirname(f)).toUpperCase() === library.toUpperCase()) return 1;
    return 2;
  };
  files.sort((a, b) => rank(a) - rank(b) || a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
  // 同一目录中只是扩展名或大小写不同的文件（如 CUST 和 CUST.cpy）也算作不同的候选，一并提示
  return { chosen: files[0], others: files.slice(1) };
}
