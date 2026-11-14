/**
 * COMP-3（packed decimal）、COMP（二进制）、COMP-1/2（浮点）的数值解码。
 * 不依赖 VS Code。数值用字符串/BigInt 处理，避免 18 位以上整数丢精度。
 */

export interface Decoded {
  text: string;
  /** false 表示字节内容不合法（如 packed 的符号半字节或数字半字节非法） */
  ok: boolean;
}

/** 把「纯数字字符串 + 小数位数 + 正负」格式化成显示文本 */
export function formatNumber(digits: string, scale: number, negative: boolean, signed: boolean): string {
  let d = digits.replace(/^0+/, '');
  let body: string;
  if (scale > 0) {
    d = d.padStart(scale + 1, '0');
    body = `${d.slice(0, -scale)}.${d.slice(-scale)}`;
  } else {
    body = d === '' ? '0' : d;
  }
  const sign = negative ? '-' : signed ? '+' : '';
  return sign + body;
}

export const POSITIVE_SIGNS = new Set([0xc, 0xf, 0xa, 0xe]);
export const NEGATIVE_SIGNS = new Set([0xd, 0xb]);

/** COMP-3：每字节两个十进制数字，最后半字节是符号（C/F/A/E=正，D/B=负） */
export function decodePacked(bytes: Uint8Array, scale: number, signed: boolean): Decoded {
  if (bytes.length === 0) {
    return { text: '', ok: false };
  }
  let digits = '';
  let ok = true;
  for (let i = 0; i < bytes.length; i++) {
    const hi = bytes[i] >> 4;
    const lo = bytes[i] & 0x0f;
    if (hi > 9) {
      ok = false;
    }
    digits += hi.toString(16);
    if (i < bytes.length - 1) {
      if (lo > 9) {
        ok = false;
      }
      digits += lo.toString(16);
    }
  }
  const signNibble = bytes[bytes.length - 1] & 0x0f;
  const negative = NEGATIVE_SIGNS.has(signNibble);
  if (!negative && !POSITIVE_SIGNS.has(signNibble)) {
    ok = false;
  }
  if (!ok) {
    return { text: '', ok: false };
  }
  return { text: formatNumber(digits, scale, negative, signed), ok: true };
}

/** COMP / BINARY：定点二进制整数，字节序可选 */
export function decodeBinary(bytes: Uint8Array, scale: number, signed: boolean, littleEndian: boolean): Decoded {
  if (bytes.length === 0) {
    return { text: '', ok: false };
  }
  let v = 0n;
  const ordered = littleEndian ? Array.from(bytes).reverse() : Array.from(bytes);
  for (const b of ordered) {
    v = (v << 8n) | BigInt(b);
  }
  if (signed && (ordered[0] & 0x80) !== 0) {
    v -= 1n << BigInt(8 * bytes.length);
  }
  const negative = v < 0n;
  return { text: formatNumber((negative ? -v : v).toString(), scale, negative, signed), ok: true };
}

/** IBM 十六进制浮点（大型机的 COMP-1 / COMP-2）：符号 1 位、指数 7 位（偏移 64，底数 16）、尾数 24 / 56 位 */
export function decodeIbmFloat(bytes: Uint8Array): number {
  const sign = bytes[0] & 0x80 ? -1 : 1;
  const exp = (bytes[0] & 0x7f) - 64;
  let frac = 0;
  for (let i = bytes.length - 1; i >= 1; i--) {
    frac = (frac + bytes[i]) / 256;
  }
  return sign * frac * Math.pow(16, exp);
}

/** 浮点数显示：COMP-1 取 7 位有效数字，COMP-2 取 15 位，避免 0.10000000149011612 这类误差显示 */
function formatFloat(n: number, single: boolean): string {
  return Number(n.toPrecision(single ? 7 : 15)).toString();
}

/** 平台 / 编译器相关的数值格式选项 */
export interface NumericOptions {
  /** COMP / COMP-4 / BINARY 是否小端（IBM、富士通等通常为大端） */
  binaryLittleEndian: boolean;
  /** COMP-5（本地格式）是否小端（NetCOBOL 在 Windows / Linux 上为小端） */
  comp5LittleEndian: boolean;
  /** COMP-1 / COMP-2 的浮点格式：IEEE 754 或 IBM 十六进制浮点 */
  floatFormat: 'ieee' | 'ibm';
}

export const DEFAULT_NUMERIC_OPTIONS: NumericOptions = {
  binaryLittleEndian: false,
  comp5LittleEndian: false,
  floatFormat: 'ieee',
};

/** 解码所需的字段属性（CopyField / Column 的子集） */
export interface NumericField {
  usage: string;
  scale: number;
  signed: boolean;
  /** PIC 中 9 的个数；0 表示未知（不做位数检查） */
  digits: number;
  signSeparate?: boolean;
  signLeading?: boolean;
}

/** 解码结果：ok=false 表示内容非法（显示十六进制）；suspect 表示能解码但可疑（如超出 PIC 位数） */
export interface NumericResult extends Decoded {
  suspect?: boolean;
}

/**
 * 按 USAGE 解码二进制类数值（COMP-3 / COMP / COMP-5 / COMP-1 / COMP-2）。
 * 不认识的 USAGE 返回 undefined（调用方回退为十六进制）。
 */
export function decodeNumeric(bytes: Uint8Array, f: NumericField, opts: NumericOptions = DEFAULT_NUMERIC_OPTIONS): NumericResult | undefined {
  switch (f.usage) {
    case 'COMP-3':
    case 'PACKED-DECIMAL': {
      const r: NumericResult = decodePacked(bytes, f.scale, f.signed);
      if (!r.ok) {
        return r;
      }
      const sign = bytes[bytes.length - 1] & 0x0f;
      // 无符号项目却带负号；或数字超出 PIC 位数（偶数位时最高的填充半字节必须为 0）
      const capacity = bytes.length * 2 - 1;
      const highDigits = f.digits > 0 && f.digits < capacity ? (bytes[0] >> 4) !== 0 : false;
      r.suspect = (!f.signed && NEGATIVE_SIGNS.has(sign)) || highDigits;
      return r;
    }
    case 'COMP':
    case 'COMP-4':
    case 'BINARY':
    case 'COMP-5': {
      const little = f.usage === 'COMP-5' ? opts.comp5LittleEndian : opts.binaryLittleEndian;
      const r: NumericResult = decodeBinary(bytes, f.scale, f.signed, little);
      // COMP / BINARY 的值不应超出 PIC 的位数（COMP-5 可以使用整个二进制范围）
      if (r.ok && f.usage !== 'COMP-5' && f.digits > 0) {
        const digitsOnly = r.text.replace(/[^0-9]/g, '').replace(/^0+/, '');
        r.suspect = digitsOnly.length > f.digits;
      }
      return r;
    }
    case 'BINARY-CHAR':
    case 'BINARY-SHORT':
    case 'BINARY-LONG':
    case 'BINARY-DOUBLE':
      // NetCOBOL 的 int 型二进制整数：本地字节序（与 COMP-5 相同；Windows / Linux 为小端），不做位数检查
      return decodeBinary(bytes, 0, f.signed, opts.comp5LittleEndian);
    case 'COMP-1':
    case 'COMP-2': {
      const want = f.usage === 'COMP-1' ? 4 : 8;
      if (bytes.length !== want) {
        return { text: '', ok: false };
      }
      let n: number;
      if (opts.floatFormat === 'ibm') {
        n = decodeIbmFloat(bytes);
      } else {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        // COMP-1 / COMP-2 的字节序与本地格式（COMP-5）相同
        n = want === 4 ? view.getFloat32(0, opts.comp5LittleEndian) : view.getFloat64(0, opts.comp5LittleEndian);
      }
      return Number.isFinite(n) ? { text: formatFloat(n, want === 4), ok: true } : { text: '', ok: false };
    }
    default:
      return undefined;
  }
}

/** 兼容旧接口：按 USAGE 解码（不做位数检查） */
export function decodeByUsage(
  bytes: Uint8Array,
  usage: string,
  scale: number,
  signed: boolean,
  littleEndian: boolean
): Decoded | undefined {
  return decodeNumeric(bytes, { usage, scale, signed, digits: 0 }, {
    binaryLittleEndian: littleEndian,
    comp5LittleEndian: littleEndian,
    floatFormat: 'ieee',
  });
}

/**
 * 外部十进制（USAGE DISPLAY 的数字项目）：校验并取出数值。
 *  - 无符号：全部为 0~9
 *  - SIGN SEPARATE：符号字节必须是 + 或 -（LEADING 在前，否则在后）
 *  - 符号嵌入（默认在末位，LEADING 时在首位）：按富士通 NetCOBOL 的内部表现
 *    （COBOL 文法書 5.4.15 USAGE 句），符号在该字节的高 4 位：
 *      0x40~0x49 → 正（+6789 = 36 37 38 49）；0x50~0x59 → 负（-6789 = 36 37 38 59）；
 *      0x30~0x39（无符号的区位）也按正数接受。
 *    其他编译器 / EBCDIC 转换后的写法（p~y、{A~I、}J~R）不支持，视为非法。
 *  空格、小数点等都视为非法。
 */
export function decodeZoned(bytes: Uint8Array, f: NumericField): NumericResult {
  const n = bytes.length;
  if (n === 0) {
    return { text: '', ok: false };
  }
  let digits = '';
  let negative = false;
  let from = 0;
  let to = n;
  if (f.signed && f.signSeparate) {
    const at = f.signLeading ? 0 : n - 1;
    const c = bytes[at];
    if (c !== 0x2b && c !== 0x2d) {
      return { text: '', ok: false };
    }
    negative = c === 0x2d;
    if (f.signLeading) from = 1;
    else to = n - 1;
  }
  for (let i = from; i < to; i++) {
    const b = bytes[i];
    const signByte = f.signed && !f.signSeparate && i === (f.signLeading ? from : to - 1);
    if (b >= 0x30 && b <= 0x39) {
      digits += String.fromCharCode(b);
    } else if (signByte && b >= 0x40 && b <= 0x49) {
      digits += String(b - 0x40);
    } else if (signByte && b >= 0x50 && b <= 0x59) {
      digits += String(b - 0x50);
      negative = true;
    } else {
      return { text: '', ok: false };
    }
  }
  if (digits === '') {
    return { text: '', ok: false };
  }
  return { text: formatNumber(digits, f.scale, negative, f.signed), ok: true };
}
