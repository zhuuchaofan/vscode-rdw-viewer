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

/** 把控制字符替换成可见的占位符，避免破坏表格显示 */
export function sanitize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, '·');
}

export function toHex(bytes: Uint8Array): string {
  const parts: string[] = [];
  for (const b of bytes) {
    parts.push(b.toString(16).toUpperCase().padStart(2, '0'));
  }
  return parts.join(' ');
}
