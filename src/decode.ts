/** 字符编码相关工具（不依赖 VS Code）。 */

export const SUPPORTED_ENCODINGS = [
  'shift_jis',
  'utf-8',
  'euc-jp',
  'gbk',
  'gb18030',
  'big5',
  'euc-kr',
  'iso-8859-1',
  'windows-1252',
];

export function createDecoder(label: string): TextDecoder | undefined {
  try {
    return new TextDecoder(label, { fatal: false, ignoreBOM: true });
  } catch {
    return undefined;
  }
}

/**
 * 把控制字符替换成 Unicode 的「控制字符图形」（0x00 → ␀、0x0D → ␍、0x7F → ␡），
 * 既不破坏表格显示，又能看出是哪个字符，并且不会和空格的标记（·）混淆。
 */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, (c) => String.fromCharCode(c === '\u007f' ? 0x2421 : 0x2400 + c.charCodeAt(0)));
}

export function toHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const b of bytes) {
    parts.push(b.toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(' ');
}

/**
 * 十六进制 dump 的文字栏：按字节返回显示文字。
 * 多字节字符放在首字节的位置，后续字节为空字符串；不可显示的字节为「.」。
 * 编码不限于 Shift_JIS：从首字节开始依次尝试 1~4 字节，能解码成一个字符就采用。
 */
export function dumpChars(bytes: Uint8Array, decoder: TextDecoder): string[] {
  const out: string[] = new Array(bytes.length).fill('');
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out[i] = b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      i++;
      continue;
    }
    let taken = 0;
    for (let n = 1; n <= 4 && i + n <= bytes.length; n++) {
      const s = decoder.decode(bytes.subarray(i, i + n));
      const cps = [...s];
      if (cps.length === 1 && s !== '�') {
        const cp = s.codePointAt(0)!;
        out[i] = cp < 0x20 || (cp >= 0x7f && cp < 0xa0) ? '.' : s;
        taken = n;
        break;
      }
    }
    if (!taken) {
      out[i] = '.';
      taken = 1;
    }
    i += taken;
  }
  return out;
}
