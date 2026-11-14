/** 比较结果的差异报告（CSV / TSV）。 */
import { RdwSession } from './session';
import { Column } from './layout';
import { ExportFormat, escapeField, exportText } from './export';
import { t } from './i18n';
import { CompareSession, counterpartColumn, sameShape } from './compare';

/**
 * 差异报告（CSV / TSV）：每个有差异的字段一行；只在一侧的记录一行。
 * 分批生成（每批若干个配对），调用方逐批编码、写入。done / total 为已处理 / 全部的配对数。
 */
export function* diffReportChunks(
  cmp: CompareSession,
  format: ExportFormat,
  batch = 500
): Generator<{ text: string; done: number; total: number; rows: number }> {
  const sep = format === 'csv' ? ',' : '\t';
  const line = (cells: Array<string | number>) => cells.map((c) => escapeField(String(c), format)).join(sep) + '\r\n';
  const total = cmp.getStats().pairs;
  let text = line([
    t('cmp.rpt.no'),
    t('cmp.rpt.status'),
    t('cmp.rpt.recA'),
    t('cmp.rpt.recB'),
    t('cmp.rpt.field'),
    t('cmp.rpt.pos'),
    t('cmp.rpt.valA'),
    t('cmp.rpt.valB'),
  ]);
  let rows = 0;
  const value = (s: RdwSession, e: number, col: Column) => exportText(s.cell(e, col).text);
  for (let p = 0; p < total; p++) {
    const { a: ea, b: eb, st } = cmp.pair(p);
    if (st === 'a' || st === 'b') {
      text += line([p + 1, t(st === 'a' ? 'cmp.rpt.onlyA' : 'cmp.rpt.onlyB'), ea >= 0 ? ea + 1 : '', eb >= 0 ? eb + 1 : '', '', '', '', '']);
      rows++;
    } else if (st === 'chg') {
      const ga = cmp.a.groupOfEntry(ea)!;
      const gb = cmp.b.groupOfEntry(eb)!;
      const { da, db } = cmp.diffColumns(ea, eb);
      const usedB = new Set<number>();
      for (const i of da) {
        const ca = ga.columns[i];
        const j = sameShape(ga.columns, gb.columns) ? i : counterpartColumn(ga.columns, i, gb.columns);
        const cb = j >= 0 ? gb.columns[j] : undefined;
        if (j >= 0) usedB.add(j);
        const pos = cb && cb.start !== ca.start ? `${ca.start}/${cb.start}` : String(ca.start);
        text += line([p + 1, t('cmp.rpt.chg'), ea + 1, eb + 1, ca.name, pos, value(cmp.a, ea, ca), cb ? value(cmp.b, eb, cb) : '']);
        rows++;
      }
      for (const j of db) {
        if (usedB.has(j)) continue;
        const cb = gb.columns[j];
        text += line([p + 1, t('cmp.rpt.chg'), ea + 1, eb + 1, cb.name, String(cb.start), '', value(cmp.b, eb, cb)]);
        rows++;
      }
    }
    if ((p + 1) % batch === 0) {
      yield { text, done: p + 1, total, rows };
      text = '';
    }
  }
  yield { text, done: total, total, rows };
}
