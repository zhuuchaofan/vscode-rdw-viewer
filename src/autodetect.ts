/**
 * 没有 copybook 时，自动识别正文中的 COMP-3（packed decimal）字段。
 *
 * 做法：把正文切分成「文字 / COMP-3 / 原始字节」三类片段，用动态规划求总代价最小的切分：
 *  - 文字：可打印 ASCII、半角片假名、合法的 SJIS 双字节字符。每开始一段新的文字要额外付出代价，
 *    这样夹在两个 COMP-3 之间、只有一两个字符的「文字」会倾向于被判为 COMP-3 的一部分。
 *  - COMP-3：除最后一个字节外每个半字节都是 0~9，最后一个字节高半字节 0~9、低半字节为 C/D/F。
 *    其中「本身也像文字」的字节会加价，避免把文字末尾的数字吞进 COMP-3。
 *  - 原始字节：以上都不是，代价最高，显示为十六进制。
 *
 * 这是启发式猜测，可能误判；有 copybook 时不使用。
 */
import { decodePacked } from './numeric';
import { sanitize, toHex } from './decode';

export type Segment =
  | { kind: 'text'; start: number; end: number }
  | { kind: 'packed'; start: number; end: number }
  | { kind: 'raw'; start: number; end: number };

/** 片段标记（私有区字符），前端据此着色；显示给人看时替换成括号 */
export const MARK = {
  packedOpen: '',
  packedClose: '',
  rawOpen: '',
  rawClose: '',
};

const COST_TEXT_RUN_START = 2;
const COST_PACKED_BASE = 1.5;
const COST_RAW = 10;
/** COMP-3 中出现「可组成 Shift_JIS 双字节字符」的首字节时的额外代价 */
const COST_PACKED_DBCS = 3.5;
const MAX_PACKED = 16; // S9(31) COMP-3

const isPrintableAscii = (b: number) => b >= 0x20 && b <= 0x7e;
const isKana = (b: number) => b >= 0xa1 && b <= 0xdf;
const isSjisLead = (b: number) => (b >= 0x81 && b <= 0x9f) || (b >= 0xe0 && b <= 0xfc);
const isSjisTrail = (b: number) => (b >= 0x40 && b <= 0x7e) || (b >= 0x80 && b <= 0xfc);
const isPackedSign = (n: number) => n === 0xc || n === 0xd || n === 0xf;

const isAlnum = (b: number) =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
/** 数据里常见的标点 */
const isCommonPunct = (b: number) => b === 0x2d || b === 0x2e || b === 0x2c || b === 0x2f || b === 0x5f || b === 0x3a || b === 0x28 || b === 0x29;

/** 把单字节当作文字的代价：越像真实数据的字符越便宜 */
function textCost(b: number): number {
  if (b === 0x20) return 0.2;
  if (isAlnum(b)) return 1;
  if (isCommonPunct(b)) return 1.2;
  return 3.5; // " # $ % & ' 等少见标点：在业务数据里很少出现，更可能是 COMP-3 的字节
}

/**
 * 把一个「本身像文字」的字节算进 COMP-3 的额外代价。
 * 数字/字母很可能是真的文字（如夹在两个 COMP-3 之间的「データ種別」'2'），代价高；
 * " # $ % 之类的标点更可能是 COMP-3 数值的一部分（如日期 2250930 = 22 50 93 0C 的 0x22），代价低。
 */
function packedPenalty(b: number): number {
  if (!isPrintableAscii(b)) return 0;
  if (isAlnum(b)) return 3.5;
  return 0.8;
}

export function segmentBody(bytes: Uint8Array, sjis = true): Segment[] {
  const n = bytes.length;
  // dp[i*2+t]：切分完前 i 个字节、且最后一段是否为文字(t=1) 时的最小代价
  const INF = Number.POSITIVE_INFINITY;
  const dp = new Float64Array((n + 1) * 2).fill(INF);
  // back[i*2+t] = 上一状态 (prevIndex*2+prevT)，kind[i*2+t] = 0 文字 / 1 COMP-3 / 2 原始
  const back = new Int32Array((n + 1) * 2).fill(-1);
  const kind = new Uint8Array((n + 1) * 2);
  dp[0] = 0;

  const relax = (from: number, to: number, cost: number, k: number) => {
    if (cost < dp[to]) {
      dp[to] = cost;
      back[to] = from;
      kind[to] = k;
    }
  };

  for (let i = 0; i < n; i++) {
    for (let t = 0; t < 2; t++) {
      const cur = dp[i * 2 + t];
      if (cur === INF) {
        continue;
      }
      const from = i * 2 + t;
      const runStart = t === 1 ? 0 : COST_TEXT_RUN_START;
      const b = bytes[i];

      // 文字
      if (isPrintableAscii(b)) {
        relax(from, (i + 1) * 2 + 1, cur + runStart + textCost(b), 0);
      } else if (sjis ? isKana(b) : b >= 0x80) {
        relax(from, (i + 1) * 2 + 1, cur + runStart + 1, 0);
      }
      if (sjis && isSjisLead(b) && i + 1 < n && isSjisTrail(bytes[i + 1])) {
        relax(from, (i + 2) * 2 + 1, cur + runStart + 1, 0);
      }

      // COMP-3：i..j
      let cost = COST_PACKED_BASE;
      for (let j = i; j < n && j < i + MAX_PACKED; j++) {
        const hi = bytes[j] >> 4;
        const lo = bytes[j] & 0x0f;
        if (hi > 9) {
          break;
        }
        cost += packedPenalty(bytes[j]);
        // 与下一字节组成合法的 Shift_JIS 双字节字符（如全角空格 81 40）时，更可能是文字
        if (sjis && j + 1 < n && isSjisLead(bytes[j]) && isSjisTrail(bytes[j + 1])) {
          cost += COST_PACKED_DBCS;
        }
        if (isPackedSign(lo)) {
          relax(from, (j + 1) * 2, cur + cost, 1);
          break; // 符号半字节必须在最后一个字节
        }
        if (lo > 9) {
          break;
        }
      }

      // 原始字节
      relax(from, (i + 1) * 2, cur + COST_RAW, 2);
    }
  }

  // 回溯
  let at = dp[n * 2] <= dp[n * 2 + 1] ? n * 2 : n * 2 + 1;
  const segs: Segment[] = [];
  while (at > 0) {
    const prev = back[at];
    const start = prev >> 1;
    const end = at >> 1;
    const k = kind[at];
    const kindName = k === 0 ? 'text' : k === 1 ? 'packed' : 'raw';
    const last = segs[segs.length - 1];
    // 相邻的同类文字/原始字节合并
    if (last && last.kind === kindName && kindName !== 'packed' && last.start === end) {
      last.start = start;
    } else {
      segs.push({ kind: kindName, start, end } as Segment);
    }
    at = prev;
  }
  return segs.reverse();
}

/** 把切分结果格式化成带标记的文本 */
export function formatSegments(bytes: Uint8Array, segs: Segment[], decoder: TextDecoder): string {
  let out = '';
  for (const s of segs) {
    const part = bytes.subarray(s.start, s.end);
    if (s.kind === 'text') {
      out += sanitize(decoder.decode(part));
    } else if (s.kind === 'packed') {
      const signed = (part[part.length - 1] & 0x0f) !== 0xf;
      out += MARK.packedOpen + decodePacked(part, 0, signed).text + MARK.packedClose;
    } else {
      out += MARK.rawOpen + toHex(part) + MARK.rawClose;
    }
  }
  return out;
}

/** 去掉标记，换成人能看懂的括号 */
export function plainSegments(text: string): string {
  return text
    .replace(//g, '[')
    .replace(//g, ']')
    .replace(//g, '‹')
    .replace(//g, '›');
}
