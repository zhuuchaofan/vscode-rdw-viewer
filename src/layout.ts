import { Copybook, FieldType } from './copybook';

export type ColumnKind = 'field' | 'partial' | 'missing' | 'extra' | 'body';

export interface Column {
  name: string;
  /** 属性，如 X(9) */
  pic: string;
  /** 在正文中的起始位置（从 1 开始，对应 TF-LINDA 的「相対位置」） */
  start: number;
  /** 实际能从这条记录里取到的字节数 */
  len: number;
  /** copybook 声明的字节数（partial/missing 时大于 len） */
  fullLen: number;
  kind: ColumnKind;
  type: FieldType;
  signed: boolean;
  /** 建议列宽（单位 ch） */
  width: number;
}

export interface Banner {
  level: 'info' | 'warn' | 'error';
  text: string;
}

export interface ColumnSet {
  columns: Column[];
  banner: Banner;
}

export type MismatchMode = 'lenient' | 'strict';

export interface CopybookRef {
  name: string;
  copybook: Copybook;
}

/** 显示宽度：全角字符按 2 个字符宽度计 */
function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1;
  }
  return w;
}

function widthOf(name: string, pic: string, len: number, kind: ColumnKind): number {
  const w = Math.max(displayWidth(name), displayWidth(pic), len) + 2;
  const max = kind === 'body' ? 3000 : 60;
  return Math.min(Math.max(w, 6), max);
}

function column(
  name: string,
  pic: string,
  start: number,
  len: number,
  fullLen: number,
  kind: ColumnKind,
  type: FieldType,
  signed: boolean
): Column {
  return { name, pic, start, len, fullLen, kind, type, signed, width: widthOf(name, pic, len, kind) };
}

function bodyColumns(bodyLen: number): Column[] {
  return [column('(正文)', `X(${bodyLen})`, 1, bodyLen, bodyLen, 'body', 'alnum', false)];
}

/**
 * 根据正文长度和 copybook 生成列定义。
 * 同一长度的所有记录共用一套列，因此长度不一致的情况在这里统一处理。
 */
export function buildColumns(
  bodyLen: number,
  ref: CopybookRef | null,
  mode: MismatchMode,
  loadError?: string
): ColumnSet {
  if (loadError) {
    return { columns: bodyColumns(bodyLen), banner: { level: 'error', text: `长度 ${bodyLen}：${loadError}` } };
  }
  if (!ref) {
    return {
      columns: bodyColumns(bodyLen),
      banner: { level: 'warn', text: `长度 ${bodyLen} 尚未指定 copybook，显示整条正文。` },
    };
  }

  const cb = ref.copybook;
  if (cb.fields.length === 0) {
    return {
      columns: bodyColumns(bodyLen),
      banner: { level: 'error', text: `copybook「${ref.name}」中没有解析出任何字段，显示整条正文。` },
    };
  }

  const copyLen = cb.totalLength;
  const warnSuffix = cb.warnings.length > 0 ? `（解析提示：${cb.warnings.join('；')}）` : '';

  if (copyLen !== bodyLen && mode === 'strict') {
    const diff =
      copyLen > bodyLen
        ? `copybook 比正文多 ${copyLen - bodyLen} 字节`
        : `正文比 copybook 多 ${bodyLen - copyLen} 字节`;
    return {
      columns: bodyColumns(bodyLen),
      banner: {
        level: 'error',
        text: `长度不一致：正文 ${bodyLen} 字节，copybook「${ref.name}」${copyLen} 字节（${diff}）。严格模式下不拆分字段。`,
      },
    };
  }

  const columns: Column[] = [];
  for (const f of cb.fields) {
    const start = f.offset + 1;
    if (f.offset + f.length <= bodyLen) {
      columns.push(column(f.name, f.pic, start, f.length, f.length, 'field', f.type, f.signed));
    } else if (f.offset < bodyLen) {
      columns.push(column(f.name, f.pic, start, bodyLen - f.offset, f.length, 'partial', f.type, f.signed));
    } else {
      columns.push(column(f.name, f.pic, start, 0, f.length, 'missing', f.type, f.signed));
    }
  }

  let banner: Banner;
  if (copyLen === bodyLen) {
    banner = {
      level: cb.warnings.length > 0 ? 'warn' : 'info',
      text: `copybook「${ref.name}」，总长 ${copyLen} 字节，${cb.fields.length} 个字段，与正文长度一致。${warnSuffix}`,
    };
  } else if (copyLen < bodyLen) {
    const extra = bodyLen - copyLen;
    columns.push(column('(余り)', `X(${extra})`, copyLen + 1, extra, extra, 'extra', 'alnum', false));
    banner = {
      level: 'warn',
      text: `长度不一致：正文 ${bodyLen} 字节，copybook「${ref.name}」${copyLen} 字节，多出的 ${extra} 字节显示在「(余り)」列。${warnSuffix}`,
    };
  } else {
    banner = {
      level: 'warn',
      text: `长度不一致：正文 ${bodyLen} 字节，copybook「${ref.name}」${copyLen} 字节，缺 ${copyLen - bodyLen} 字节；被截断的字段标橙，完全缺失的字段显示「—」。${warnSuffix}`,
    };
  }
  return { columns, banner };
}
