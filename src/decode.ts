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
