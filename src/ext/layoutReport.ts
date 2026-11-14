/** 「解析详情」：copybook 解析结果的文字说明。 */
import { RdwSession, Group, discriminatorLabel } from '../session';
import { t } from '../i18n';

/** 生成「解析详情」文本：copybook 中每个字段的位置、长度，便于和 copybook 原文对照 */
export function describeLayout(session: RdwSession, g: Group): string {
  const length = g.length;
  if (!g.copybook) {
    return t('ext.layout.noCopybook', { len: length });
  }
  const cb = g.copybook.copybook;
  const lines: string[] = [];
  lines.push(t('ext.layout.copybook', { name: g.copybook.name }));
  lines.push(t('ext.layout.length', { len: length }));
  const disc = session.getDiscriminator(length);
  if (g.value !== undefined && disc) {
    lines.push(t('ext.layout.disc', { label: discriminatorLabel(disc), value: g.value }));
  }
  lines.push(
    t('ext.layout.records', {
      list:
        cb.records.map((r) => t('ext.layout.recordItem', { name: r.name, len: r.totalLength })).join(t('list.sep')) ||
        t('ext.layout.none'),
    })
  );
  const fields = g.columns.filter((c) => c.kind !== 'extra' && c.kind !== 'body');
  const copyLen = fields.reduce((m, c) => Math.max(m, c.start - 1 + c.fullLen), 0);
  lines.push(t('ext.layout.selected', { name: g.copybook.name, len: copyLen, n: fields.length }));
  if (copyLen !== length) {
    lines.push(t(copyLen > length ? 'ext.layout.diffMore' : 'ext.layout.diffLess', { n: Math.abs(copyLen - length) }));
  }
  for (const c of g.choices) {
    lines.push(
      t('ext.layout.choice', {
        base: c.base === '01' ? t('ui.layoutRecord') : `REDEFINES ${c.base}`,
        list: c.options.map((o) => (o === c.selected ? `[${o}]` : o)).join(' / '),
      })
    );
  }
  if (cb.warnings.length) {
    lines.push('', t('ext.layout.warnings'));
    cb.warnings.forEach((w) => lines.push(`  - ${w}`));
  }
  lines.push(
    '',
    [
      'No.'.padStart(5),
      t('ext.layout.colPos').padStart(6),
      t('ext.layout.colLen').padStart(6),
      t('ext.layout.colEnd').padStart(6),
      ('  ' + t('ext.layout.colPic')).padEnd(26),
      t('ext.layout.colName'),
    ].join(' ')
  );
  fields.forEach((f, i) => {
    lines.push(
      [
        String(i + 1).padStart(5),
        String(f.start).padStart(6),
        String(f.fullLen).padStart(6),
        String(f.start - 1 + f.fullLen).padStart(6),
        ('  ' + f.pic).padEnd(26),
        f.name,
      ].join(' ')
    );
  });
  return lines.join('\n') + '\n';
}
