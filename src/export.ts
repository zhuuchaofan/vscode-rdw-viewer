/**
 * 把一个标签页（分组 / 错误列表）导出为 CSV 或 TSV 的文本行。不依赖 VS Code。
 * 大文件分批生成，调用方逐批编码、写入，不会一次性占用大量内存。
 */
import { RdwSession, ERR_VIEW, ORDER_VIEW, RecRow, ErrRow } from './session';
import { t } from './i18n';

export type ExportFormat = 'csv' | 'tsv';

export interface ExportOptions {
  format: ExportFormat;
  /** 字段名表头行 */
  header: boolean;
  /** 属性、相对位置两行 */
  meta: boolean;
  /** 每行前加记录序号、偏移列 */
  position: boolean;
}

export const DEFAULT_EXPORT_OPTIONS: Omit<ExportOptions, 'format'> = { header: true, meta: true, position: true };

/** CSV：含逗号、引号、换行时用双引号括起来；TSV：把制表符、换行替换为空格 */
export function escapeField(value: string, format: ExportFormat): string {
  if (format === 'tsv') {
    return value.replace(/[\t\r\n]/g, ' ');
  }
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** 自动识别的片段标记换成导出用的 ASCII 括号：COMP-3 → [值]，原始字节 → <十六进制> */
export function exportText(text: string): string {
  return text
    .replace(/[\u2400-\u241f\u2421]/g, '·') // 控制字符图形 → ·（Shift_JIS 中为 ・，与之前的导出结果相同）
    .replace(//g, '[')
    .replace(//g, ']')
    .replace(//g, '<')
    .replace(//g, '>');
}

const fmtOffset = (n: number): string => '0x' + n.toString(16).toUpperCase().padStart(8, '0');
const trimLabel = (s: string): string => s.replace(/\s+/g, '');

/** 可导出的视图：分组标签页和错误列表（文件顺序视图各组列不同，不能导出为一张表） */
export function canExport(view: string): boolean {
  return view !== ORDER_VIEW;
}

/**
 * 逐批生成导出的文本（每批若干行，每行以 CRLF 结尾）。
 * onProgress(done, total) 用于显示进度。
 */
export function* exportChunks(
  session: RdwSession,
  view: string,
  opts: ExportOptions,
  batch = 1000
): Generator<{ text: string; done: number; total: number }> {
  if (!canExport(view)) {
    throw new Error(`cannot export view ${view}`);
  }
  const line = (cells: string[]) => cells.map((c) => escapeField(c, opts.format)).join(opts.format === 'csv' ? ',' : '\t') + '\r\n';
  const total = session.count(view);
  let head = '';

  if (view === ERR_VIEW) {
    if (opts.header) {
      head += line([...(opts.position ? ['#'] : []), t('ui.offset'), t('ui.skipped'), t('ui.reason')]);
    }
  } else {
    const g = session.groupByKey(view);
    if (!g) {
      throw new Error(`unknown view ${view}`);
    }
    const lead = (label: string, offsetLabel: string) => (opts.position ? [label, offsetLabel] : []);
    if (opts.header) {
      head += line([...lead('#', t('ui.offset')), ...g.columns.map((c) => c.name)]);
    }
    if (opts.meta) {
      head += line([...lead(trimLabel(t('ui.hdrPic')), ''), ...g.columns.map((c) => c.pic)]);
      head += line([...lead(trimLabel(t('ui.hdrPos')), ''), ...g.columns.map((c) => String(c.start))]);
    }
  }

  if (head || total === 0) {
    yield { text: head, done: 0, total };
  }
  for (let start = 0; start < total; start += batch) {
    let text = '';
    for (const row of session.getRows(view, start, batch)) {
      if (row.t === 'err') {
        const r = row as ErrRow;
        text += line([...(opts.position ? [String(r.e + 1)] : []), ...r.c]);
      } else if (row.t === 'rec') {
        const r = row as RecRow;
        text += line([...(opts.position ? [String(r.e + 1), fmtOffset(r.o)] : []), ...r.c.map(exportText)]);
      }
    }
    yield { text, done: Math.min(start + batch, total), total };
  }
}

/** 导出文件名中用的分组标识，如 1600、1600_+10200、errors */
export function viewFileSuffix(session: RdwSession, view: string): string {
  if (view === ERR_VIEW) {
    return 'errors';
  }
  const g = session.groupByKey(view);
  if (!g) {
    return view;
  }
  const value = g.value === undefined ? '' : '_' + g.value.replace(/[\\/:*?"<>|\s]+/g, '_');
  return `${g.length}${value}`;
}
