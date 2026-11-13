import { t } from './i18n';
import { Copybook, CopyField, CopyRecord, FieldType, LayoutSelection, layoutRecord, selectRecord } from './copybook';

export type ColumnKind = 'field' | 'partial' | 'missing' | 'extra' | 'body';

export interface Column {
  name: string;
  /** 属性，如 X(9) */
  pic: string;
  /** 在正文中的起始位置（从 1 开始，即表头的「相対位置」） */
  start: number;
  /** 实际能从这条记录里取到的字节数 */
  len: number;
  /** copybook 声明的字节数（partial/missing 时大于 len） */
  fullLen: number;
  kind: ColumnKind;
  type: FieldType;
  signed: boolean;
  /** USAGE：COMP-3 / COMP 等字段会解码成数值显示 */
  usage: string;
  /** 小数位数 */
  scale: number;
  /** PIC 中 9 的个数（用于位数检查） */
  digits: number;
  signSeparate: boolean;
  signLeading: boolean;
  /** 建议列宽（单位 ch） */
  width: number;
}

export interface Banner {
  level: 'info' | 'warn' | 'error';
  text: string;
}

/** 可以切换的布局（REDEFINES，或同长度的多个 01）及当前选择 */
export interface LayoutChoice {
  /** 选择的保存键：REDEFINES 原项目的限定名，或 '01'（记录定义） */
  id: string;
  /** 显示名：原项目名，或「01」 */
  base: string;
  options: string[];
  selected: string;
}

export interface ColumnSet {
  columns: Column[];
  banner: Banner;
  /** 当前布局中可以切换的区域（没有时为空数组） */
  choices: LayoutChoice[];
}

/** 记录定义（多个 01）的选择键 */
export const RECORD_CHOICE_ID = '01';

/** 解析提示的后缀（没有提示时为空） */
function warnSuffixOf(warnings: string[]): string {
  return warnings.length > 0 ? t('banner.warnSuffix', { list: warnings.join(t('warn.sep')) }) : '';
}

export type MismatchMode = 'lenient' | 'strict';

export interface CopybookRef {
  name: string;
  copybook: Copybook;
}

/** 显示宽度：全角字符按 2 个字符宽度计 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  }
  return w;
}

type FieldAttrs = Pick<CopyField, 'type' | 'signed' | 'usage' | 'scale' | 'digits' | 'signSeparate' | 'signLeading'>;

const TEXT_ATTRS: FieldAttrs = {
  type: 'alnum',
  signed: false,
  usage: 'DISPLAY',
  scale: 0,
  digits: 0,
  signSeparate: false,
  signLeading: false,
};

/**
 * 值的显示宽度估计：二进制类数值按解码后的位数（符号、小数点各 1），浮点按有效数字，
 * 其他按字节数。
 */
function valueWidth(len: number, attrs: FieldAttrs): number {
  switch (attrs.usage) {
    case 'COMP-1':
      return 13; // 例：-1.234567e+38
    case 'COMP-2':
      return 21;
    case 'COMP-3':
    case 'PACKED-DECIMAL':
    case 'COMP':
    case 'COMP-4':
    case 'COMP-5':
    case 'BINARY':
      // COMP 无符号时最大值的位数可能比 PIC 多（如 9(4) COMP 的 65535）
      return Math.max(attrs.digits, len * 2.5) + 2;
    default:
      return len;
  }
}

function widthOf(name: string, pic: string, len: number, kind: ColumnKind, attrs: FieldAttrs = TEXT_ATTRS): number {
  const w = Math.max(displayWidth(name), displayWidth(pic), Math.ceil(valueWidth(len, attrs))) + 2;
  const max = kind === 'body' ? 3000 : 60;
  return Math.min(Math.max(w, 6), max);
}

function column(name: string, pic: string, start: number, len: number, fullLen: number, kind: ColumnKind, attrs: FieldAttrs): Column {
  return {
    name,
    pic,
    start,
    len,
    fullLen,
    kind,
    type: attrs.type,
    signed: attrs.signed,
    usage: attrs.usage,
    scale: attrs.scale,
    digits: attrs.digits,
    signSeparate: attrs.signSeparate,
    signLeading: attrs.signLeading,
    width: widthOf(name, pic, len, kind, attrs),
  };
}

function bodyColumns(bodyLen: number): Column[] {
  return [column(t('col.body'), `X(${bodyLen})`, 1, bodyLen, bodyLen, 'body', TEXT_ATTRS)];
}

/**
 * 选择 01 记录：同长度的 01 有多个时，按选择（'01'）决定；否则按长度自动选。
 * 返回选中的记录，以及可供切换的同长度记录名。
 */
function chooseRecord(cb: Copybook, bodyLen: number, sel: LayoutSelection): { record?: CopyRecord; sameLength: string[] } {
  const same = cb.records.filter((r) => r.totalLength === bodyLen);
  if (same.length >= 2) {
    const want = (sel[RECORD_CHOICE_ID] ?? '').toUpperCase();
    return { record: same.find((r) => r.name.toUpperCase() === want) ?? same[0], sameLength: same.map((r) => r.name) };
  }
  return { record: selectRecord(cb, bodyLen), sameLength: [] };
}

/**
 * 根据正文长度和 copybook 生成列定义。
 * 同一长度（或同一判别字段值）的所有记录共用一套列，因此长度不一致的情况在这里统一处理。
 * sel 为 REDEFINES / 01 记录的布局选择。
 */
export function buildColumns(
  bodyLen: number,
  ref: CopybookRef | null,
  mode: MismatchMode,
  loadError?: string,
  sel: LayoutSelection = {}
): ColumnSet {
  if (loadError) {
    return {
      columns: bodyColumns(bodyLen),
      banner: { level: 'error', text: t('banner.loadError', { len: bodyLen, error: loadError }) },
      choices: [],
    };
  }
  if (!ref) {
    return {
      columns: bodyColumns(bodyLen),
      banner: { level: 'warn', text: t('banner.noCopybook', { len: bodyLen }) },
      choices: [],
    };
  }

  const cb = ref.copybook;
  const { record, sameLength } = chooseRecord(cb, bodyLen, sel);
  if (!record || record.fields.length === 0) {
    return {
      columns: bodyColumns(bodyLen),
      banner: { level: 'error', text: t('banner.noFields', { name: ref.name, warn: warnSuffixOf(cb.warnings) }) },
      choices: [],
    };
  }
  const layout = layoutRecord(record, sel);
  const fields = layout.fields;

  const choices: LayoutChoice[] = [];
  if (sameLength.length >= 2) {
    choices.push({ id: RECORD_CHOICE_ID, base: RECORD_CHOICE_ID, options: sameLength, selected: record.name });
  }
  for (const set of layout.sets) {
    const want = (sel[set.id] ?? '').toUpperCase();
    choices.push({
      id: set.id,
      base: set.base,
      options: set.options,
      selected: set.options.find((o) => o.toUpperCase() === want) ?? set.options[0],
    });
  }

  // 多个 01 时说明选用了哪一个
  const recordNote =
    cb.records.length > 1
      ? t('banner.records', {
          n: cb.records.length,
          list: cb.records.map((r) => `${r.name}=${r.totalLength}`).join(t('list.sep')),
          name: record.name,
        })
      : '';

  const copyLen = layout.totalLength;
  const warnSuffix = warnSuffixOf(cb.warnings);

  if (copyLen !== bodyLen && mode === 'strict') {
    const diff =
      copyLen > bodyLen ? t('banner.copyLonger', { n: copyLen - bodyLen }) : t('banner.bodyLonger', { n: bodyLen - copyLen });
    return {
      columns: bodyColumns(bodyLen),
      banner: { level: 'error', text: t('banner.strict', { body: bodyLen, name: ref.name, copy: copyLen, diff }) },
      choices: [],
    };
  }

  const columns: Column[] = [];
  for (const f of fields) {
    const start = f.offset + 1;
    if (f.offset + f.length <= bodyLen) {
      columns.push(column(f.name, f.pic, start, f.length, f.length, 'field', f));
    } else if (f.offset < bodyLen) {
      columns.push(column(f.name, f.pic, start, bodyLen - f.offset, f.length, 'partial', f));
    } else {
      columns.push(column(f.name, f.pic, start, 0, f.length, 'missing', f));
    }
  }

  let banner: Banner;
  if (copyLen === bodyLen) {
    banner = {
      level: cb.warnings.length > 0 ? 'warn' : 'info',
      text: t('banner.ok', { name: ref.name, copy: copyLen, fields: fields.length, records: recordNote, warn: warnSuffix }),
    };
  } else if (copyLen < bodyLen) {
    const extra = bodyLen - copyLen;
    columns.push(column(t('col.extra'), `X(${extra})`, copyLen + 1, extra, extra, 'extra', TEXT_ATTRS));
    banner = {
      level: 'warn',
      text: t('banner.extra', { body: bodyLen, name: ref.name, copy: copyLen, extra, col: t('col.extra'), records: recordNote, warn: warnSuffix }),
    };
  } else {
    banner = {
      level: 'warn',
      text: t('banner.short', { body: bodyLen, name: ref.name, copy: copyLen, short: copyLen - bodyLen, records: recordNote, warn: warnSuffix }),
    };
  }
  return { columns, banner, choices };
}
