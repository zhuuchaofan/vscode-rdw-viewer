/** 判别字段（同一长度按字段值区分 copybook）的设置。 */
import * as vscode from 'vscode';
import { RdwSession, Discriminator, Group, discriminatorLabel } from '../session';
import { t } from '../i18n';

const MAX_DISC_VALUES = 50;

/**
 * 「按字段值区分」：选择判别字段（从当前 copybook 的字段中选，或手动输入位置/长度/类型），
 * 预览各值的条数，确认后返回判别字段。
 */
export async function pickDiscriminator(session: RdwSession, g: Group): Promise<Discriminator | undefined> {
  interface Item extends vscode.QuickPickItem {
    d?: Discriminator;
    manual?: boolean;
  }
  const items: Item[] = [];
  if (g.copybook) {
    // 当前显示的布局（含 REDEFINES 的选择）中、完整落在记录内的字段
    for (const c of g.columns.filter((x) => x.kind === 'field')) {
      const type = c.usage === 'COMP-3' || c.usage === 'PACKED-DECIMAL' ? 'comp3' : 'text';
      items.push({
        label: c.name,
        description: t('ext.disc.fieldDesc', { pos: c.start, len: c.len, pic: c.pic }),
        d: { start: c.start, length: c.len, type },
      });
    }
  }
  items.push({ label: t('ext.disc.manual'), manual: true });

  const pick = await vscode.window.showQuickPick(items, {
    title: t('ext.disc.pickTitle', { len: g.length }),
    placeHolder: g.copybook ? t('ext.disc.fieldsFrom', { name: g.copybook.name }) : t('ext.disc.noCopybook'),
    matchOnDescription: true,
  });
  if (!pick) {
    return undefined;
  }
  let d = pick.d;
  if (pick.manual) {
    const num = (min: number, max: number) => (v: string) =>
      /^\d+$/.test(v.trim()) && +v >= min && +v <= max ? undefined : t('ext.disc.intRange', { min, max });
    const start = await vscode.window.showInputBox({
      title: t('ext.disc.startTitle'),
      prompt: t('ext.disc.startPrompt', { len: g.length }),
      value: '1',
      validateInput: num(1, g.length),
    });
    if (!start) return undefined;
    const len = await vscode.window.showInputBox({
      title: t('ext.disc.lenTitle'),
      value: '1',
      validateInput: num(1, Math.min(16, g.length - +start + 1)),
    });
    if (!len) return undefined;
    const type = await vscode.window.showQuickPick(
      [
        { label: t('disc.text'), description: t('ext.disc.typeTextDesc'), t: 'text' as const },
        { label: 'COMP-3', description: t('ext.disc.typeComp3Desc'), t: 'comp3' as const },
      ],
      { title: t('ext.disc.typeTitle') }
    );
    if (!type) return undefined;
    d = { start: +start, length: +len, type: type.t };
  }
  if (!d) {
    return undefined;
  }

  const values = session.discriminatorValues(g.length, d);
  if (values.length > MAX_DISC_VALUES) {
    vscode.window.showWarningMessage(
      t('ext.disc.tooMany', { len: g.length, n: values.length })
    );
    return undefined;
  }
  interface Confirm extends vscode.QuickPickItem {
    ok?: boolean;
  }
  const confirm = await vscode.window.showQuickPick<Confirm>(
    [
      { label: t('ext.disc.confirm', { n: values.length }), ok: true },
      { label: t('ext.disc.counts'), kind: vscode.QuickPickItemKind.Separator },
      ...values.map((v) => ({ label: v.value, description: t('ext.disc.count', { n: v.count }) })),
    ],
    { title: t('ext.disc.valuesTitle', { label: discriminatorLabel(d) }) }
  );
  return confirm?.ok ? d : undefined;
}
