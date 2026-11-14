/** PICTURE 与 USAGE：字段的字节数、位数、小数位数。 */
import { FieldType } from './types';

/** int 型二进制整数（NetCOBOL）的字节数 */
export const INT_SIZES: Record<string, number> = { 'BINARY-CHAR': 1, 'BINARY-SHORT': 2, 'BINARY-LONG': 4, 'BINARY-DOUBLE': 8 };

export const NO_PIC_USAGES = new Set(['COMP-1', 'COMP-2', 'INDEX', 'POINTER', ...Object.keys(INT_SIZES)]);

export const USAGE_WORDS = new Set([
  'COMP', 'COMP-1', 'COMP-2', 'COMP-3', 'COMP-4', 'COMP-5', 'BINARY', 'PACKED-DECIMAL', 'DISPLAY',
  'NATIONAL', 'DISPLAY-1', 'INDEX', 'POINTER', 'BIT', ...Object.keys(INT_SIZES),
]);

/** COMPUTATIONAL-3 → COMP-3 等 */
export function normalizeUsage(u: string): string {
  return u.replace(/^COMPUTATIONAL/, 'COMP');
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
export function validPic(pic: string): boolean {
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
