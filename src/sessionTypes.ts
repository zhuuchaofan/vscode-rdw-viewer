/** 会话（一个已打开文件）的类型：分组、发给 webview 的行 / 单元格 / dump 数据等。 */
import { Copybook, LayoutSelection } from './copybook';
import { Banner, Column, LayoutChoice, MismatchMode } from './layout';

/** 判别字段：同一长度的记录，按这个字段的值选用不同的 copybook */
export type DiscriminatorType = 'text' | 'comp3';
export interface Discriminator {
  /** 在正文中的起始位置（从 1 开始） */
  start: number;
  length: number;
  type: DiscriminatorType;
}

export type CopybookRef = { name: string; copybook: Copybook };

export interface SessionOptions {
  encoding?: string;
  mismatch?: MismatchMode;
  /** COMP / COMP-4 / BINARY 的字节序 */
  binaryEndian?: 'big' | 'little';
  /** COMP-5 / COMP-1 / COMP-2 的字节序；省略时与 binaryEndian 相同 */
  comp5Endian?: 'big' | 'little';
  floatFormat?: 'ieee' | 'ibm';
  autoPacked?: boolean;
}

export interface Group {
  key: string;
  length: number;
  /** 按判别字段分组时的字段值；未按字段值区分时为 undefined */
  value?: string;
  entries: Uint32Array;
  copybook: { name: string; copybook: Copybook } | null;
  loadError?: string;
  /** copybook 未保存设置、按长度自动选择的 */
  auto: boolean;
  columns: Column[];
  banner: Banner;
  /** REDEFINES / 01 记录的布局选择 */
  layoutSel: LayoutSelection;
  /** 当前可以切换的布局 */
  choices: LayoutChoice[];
}

export interface GroupInfo {
  key: string;
  length: number;
  value: string | null;
  discLabel: string | null;
  count: number;
  copybookName: string | null;
  /** copybook 是按长度自动选择的 */
  auto: boolean;
  banner: Banner;
  columns: Column[];
  choices: LayoutChoice[];
}

export interface InitPayload {
  type: 'init';
  fileName: string;
  size: number;
  encoding: string;
  encodings: string[];
  total: number;
  errorCount: number;
  orderCount: number;
  groups: GroupInfo[];
  mismatch: MismatchMode;
  /** 没有 copybook 时是否自动识别 COMP-3 */
  autoPacked: boolean;
}

export interface RecRow {
  t: 'rec';
  /** 条目序号（从 0 开始，文件中的第几条） */
  e: number;
  /** 偏移 */
  o: number;
  g: string;
  c: string[];
  /** 需要标橙的列下标 */
  w: number[];
}
export interface ErrRow {
  t: 'err';
  e: number;
  o: number;
  g: 'ERR';
  c: string[];
}
export interface HdrRow {
  t: 'hdr';
  g: string;
  k: number;
}
export type Row = RecRow | ErrRow | HdrRow;

export interface CellInfo {
  /** 外部十进制（DISPLAY 数字）解码后的数值，便于确认小数位、符号 */
  value?: string;
  name: string;
  pic: string;
  start: number;
  len: number;
  text: string;
  hex: string;
  warn: boolean;
}

/** 十六进制 dump 中的字段范围 */
export interface DumpField {
  name: string;
  /** 从 1 开始的位置 */
  start: number;
  len: number;
  /** 对应的列下标 */
  col: number;
}

/** 一条记录（或错误条目跳过的字节）的十六进制 dump */
export interface DumpInfo {
  entry: number;
  /** 文件内偏移：正常记录为前置 RDW 的位置，错误条目为出错位置 */
  offset: number;
  groupKey: string | null;
  /** 错误条目的原因；正常记录为 null */
  error: string | null;
  /** 前置 / 后置 RDW 的十六进制（错误条目为 null） */
  front: string | null;
  back: string | null;
  bytes: number[];
  /** 文字栏：多字节字符在首字节位置，后续字节为空字符串 */
  chars: string[];
  fields: DumpField[];
  /** 错误条目的字节过多时只取开头部分 */
  truncated: boolean;
}

/** 错误条目的 dump 最多显示的字节数 */
export const DUMP_ERROR_LIMIT = 4096;

export const ERR_VIEW = 'ERR';
export const ORDER_VIEW = 'ORDER';
