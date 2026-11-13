/**
 * Shift_JIS（WHATWG / Windows-31J）编码器。
 *
 * Node.js 的 TextEncoder 只支持 UTF-8，这里用内置的 TextDecoder('shift_jis') 反向生成对照表，
 * 保证「导出时的编码」与「读取文件时的解码」完全一致，且不需要第三方依赖。
 */

/** 码位 → 编码（< 0x100 为单字节，否则高 8 位是首字节） */
let table: Map<number, number> | undefined;

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

function buildTable(): Map<number, number> {
  const dec = new TextDecoder('shift_jis');
  const m = new Map<number, number>();
  for (let b = 0; b < 0x80; b++) {
    m.set(b, b);
  }
  for (const b of range(0xa1, 0xdf)) {
    m.set(dec.decode(Uint8Array.of(b)).codePointAt(0)!, b);
  }
  const leads = [...range(0x81, 0x9f), ...range(0xe0, 0xfc)];
  // 同一个字符有多个编码时（NEC 选定 IBM 扩展字符 ED/EE 与 IBM 扩展字符 FA~FC），优先使用 ED/EE 以外的编码
  const passes = [leads.filter((l) => l !== 0xed && l !== 0xee), [0xed, 0xee]];
  for (const pass of passes) {
    for (const lead of pass) {
      for (const trail of [...range(0x40, 0x7e), ...range(0x80, 0xfc)]) {
        const s = dec.decode(Uint8Array.of(lead, trail));
        const cp = s.codePointAt(0)!;
        if (s.length === 1 && s !== '�' && !m.has(cp)) {
          m.set(cp, (lead << 8) | trail);
        }
      }
    }
  }
  // JIS 与 Windows-31J 写法不同的常见字符，以及界面上用到的符号
  const alias: Array<[number, number]> = [
    [0x00b7, 0x30fb], // · → ・
    [0x2014, 0x2015], // — → ―
    [0x301c, 0xff5e], // 〜 → ～
    [0x2016, 0x2225], // ‖ → ∥
    [0x2212, 0xff0d], // − → －
    [0x00a2, 0xffe0], // ¢ → ￠
    [0x00a3, 0xffe1], // £ → ￡
    [0x00ac, 0xffe2], // ¬ → ￢
  ];
  for (const [from, to] of alias) {
    const code = m.get(to);
    if (code !== undefined && !m.has(from)) {
      m.set(from, code);
    }
  }
  m.set(0x00a5, 0x5c); // ¥ → \
  m.set(0x203e, 0x7e); // ‾ → ~
  return m;
}

export interface EncodeResult {
  bytes: Uint8Array;
  /** 无法用 Shift_JIS 表示、被替换为 ? 的字符数 */
  unmappable: number;
}

export function encodeShiftJis(text: string): EncodeResult {
  table ??= buildTable();
  const out = new Uint8Array(text.length * 2);
  let n = 0;
  let unmappable = 0;
  for (const ch of text) {
    const code = table.get(ch.codePointAt(0)!);
    if (code === undefined) {
      out[n++] = 0x3f;
      unmappable++;
    } else if (code < 0x100) {
      out[n++] = code;
    } else {
      out[n++] = code >> 8;
      out[n++] = code & 0xff;
    }
  }
  return { bytes: out.subarray(0, n), unmappable };
}
