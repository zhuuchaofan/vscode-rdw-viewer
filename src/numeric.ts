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

const POSITIVE_SIGNS = new Set([0xc, 0xf, 0xa, 0xe]);
const NEGATIVE_SIGNS = new Set([0xd, 0xb]);

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

/**
 * 按 USAGE 解码；不认识的 USAGE 返回 undefined（调用方回退为十六进制）。
 */
export function decodeByUsage(
  bytes: Uint8Array,
  usage: string,
  scale: number,
  signed: boolean,
  littleEndian: boolean
): Decoded | undefined {
  switch (usage) {
    case 'COMP-3':
    case 'PACKED-DECIMAL':
      return decodePacked(bytes, scale, signed);
    case 'COMP':
    case 'COMP-4':
    case 'COMP-5':
    case 'BINARY':
      return decodeBinary(bytes, scale, signed, littleEndian);
    case 'COMP-1':
    case 'COMP-2': {
      const want = usage === 'COMP-1' ? 4 : 8;
      if (bytes.length !== want) {
        return { text: '', ok: false };
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const n = want === 4 ? view.getFloat32(0, littleEndian) : view.getFloat64(0, littleEndian);
      return { text: String(n), ok: Number.isFinite(n) };
    }
    default:
      return undefined;
  }
}
