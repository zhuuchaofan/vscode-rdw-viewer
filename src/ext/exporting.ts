/** CSV / TSV 导出：格式选择、分批写入（进度、取消）、导出单个视图或全部视图。 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RdwSession, ERR_VIEW } from '../session';
import { t } from '../i18n';
import { canExport, exportChunks, viewFileSuffix, DEFAULT_EXPORT_OPTIONS, ExportFormat } from '../export';
import { encodeShiftJis } from '../sjisEncode';
import { config } from './config';

const LAST_FORMAT_KEY = 'rdwViewer.lastExportFormat';

/** 选择导出格式（记住上次的选择） */
export async function pickExportFormat(ctx: vscode.ExtensionContext): Promise<ExportFormat | undefined> {
  const last = ctx.globalState.get<ExportFormat>(LAST_FORMAT_KEY, 'csv');
  const items = [
    { label: 'CSV', description: t('ext.export.csvDesc'), f: 'csv' as const },
    { label: 'TSV', description: t('ext.export.tsvDesc'), f: 'tsv' as const },
  ].sort((a, b) => Number(b.f === last) - Number(a.f === last));
  const pick = await vscode.window.showQuickPick(items, { title: t('ext.export.formatTitle') });
  if (pick) {
    await ctx.globalState.update(LAST_FORMAT_KEY, pick.f);
  }
  return pick?.f;
}

interface ExportResult {
  records: number;
  unmappable: number;
}

/**
 * 把一个视图写入文件：分批生成文本、编码、追加写入，显示进度，可取消。
 * 取消或失败时删除未完成的文件。
 */
async function writeExport(
  session: RdwSession,
  view: string,
  format: ExportFormat,
  file: vscode.Uri,
  encoding: 'shift_jis' | 'utf-8-bom',
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  share: number
): Promise<ExportResult | undefined> {
  return writeChunks(exportChunks(session, view, { ...DEFAULT_EXPORT_OPTIONS, format }), file, encoding, progress, token, share);
}

/**
 * 把分批生成的文本写入文件：逐批编码、追加写入，显示进度，可取消。
 * 取消或失败时删除未完成的文件。records 为最后一批的 rows（没有时为 done）。
 */
export async function writeChunks(
  chunks: Iterable<{ text: string; done: number; total: number; rows?: number }>,
  file: vscode.Uri,
  encoding: 'shift_jis' | 'utf-8-bom',
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  token: vscode.CancellationToken,
  share: number
): Promise<ExportResult | undefined> {
  const encode = (text: string) =>
    encoding === 'shift_jis' ? encodeShiftJis(text) : { bytes: new TextEncoder().encode(text), unmappable: 0 };
  const local = file.scheme === 'file';
  const parts: Uint8Array[] = [];
  const fd = local ? await fs.promises.open(file.fsPath, 'w') : undefined;
  let unmappable = 0;
  let records = 0;
  let reported = 0;
  try {
    if (encoding === 'utf-8-bom') {
      const bom = Uint8Array.of(0xef, 0xbb, 0xbf);
      fd ? await fd.write(bom) : parts.push(bom);
    }
    for (const chunk of chunks) {
      if (token.isCancellationRequested) {
        return undefined;
      }
      const r = encode(chunk.text);
      unmappable += r.unmappable;
      fd ? await fd.write(r.bytes) : parts.push(r.bytes);
      records = chunk.rows ?? chunk.done;
      const pct = chunk.total ? (chunk.done / chunk.total) * share : share;
      progress.report({ increment: pct - reported });
      reported = pct;
    }
  } finally {
    await fd?.close();
    if (token.isCancellationRequested) {
      await vscode.workspace.fs.delete(file).then(undefined, () => undefined);
    }
  }
  if (!local) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const all = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      all.set(p, at);
      at += p.length;
    }
    await vscode.workspace.fs.writeFile(file, all);
  }
  return { records, unmappable };
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  return vscode.workspace.fs.stat(uri).then(
    () => true,
    () => false
  );
}

/** 导出完成后的提示（带「打开所在文件夹」按钮） */
export async function notifyExported(message: string, unmappable: number, target: vscode.Uri): Promise<void> {
  const text = unmappable ? `${message} ${t('ext.export.unmappable', { n: unmappable })}` : message;
  const show = unmappable ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  const btn = await show(text, t('ext.export.reveal'));
  if (btn) {
    await vscode.commands.executeCommand('revealFileInOS', target);
  }
}

/** 导出当前标签页 */
export async function exportView(ctx: vscode.ExtensionContext, session: RdwSession, dataUri: vscode.Uri, view: string): Promise<void> {
  if (!canExport(view)) {
    return;
  }
  const format = await pickExportFormat(ctx);
  if (!format) {
    return;
  }
  const base = path.basename(dataUri.fsPath).replace(/\.[^.]*$/, '');
  const target = await vscode.window.showSaveDialog({
    title: t('ext.export.saveTitle'),
    defaultUri: vscode.Uri.joinPath(dataUri, '..', `${base}_${viewFileSuffix(session, view)}.${format}`),
    filters: { [format.toUpperCase()]: [format] },
  });
  if (!target) {
    return;
  }
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('ext.export.progress', { name: path.basename(target.fsPath) }), cancellable: true },
      (progress, token) => writeExport(session, view, format, target, config().exportEncoding, progress, token, 100)
    );
    if (!result) {
      vscode.window.showInformationMessage(t('ext.export.cancelled'));
      return;
    }
    await notifyExported(t('ext.export.done', { n: result.records, path: target.fsPath }), result.unmappable, target);
  } catch (e) {
    vscode.window.showErrorMessage(t('ext.export.failed', { error: (e as Error).message }));
  }
}

/** 全部导出：每个分组（以及错误列表）各一个文件 */
export async function exportAll(ctx: vscode.ExtensionContext, session: RdwSession, dataUri: vscode.Uri): Promise<void> {
  const format = await pickExportFormat(ctx);
  if (!format) {
    return;
  }
  const dirs = await vscode.window.showOpenDialog({
    title: t('ext.export.folderTitle'),
    openLabel: t('ext.export.folderButton'),
    canSelectFiles: false,
    canSelectFolders: true,
    defaultUri: vscode.Uri.joinPath(dataUri, '..'),
  });
  const dir = dirs?.[0];
  if (!dir) {
    return;
  }
  const base = path.basename(dataUri.fsPath).replace(/\.[^.]*$/, '');
  const views = [...session.groups.map((g) => g.key), ...(session.count(ERR_VIEW) ? [ERR_VIEW] : [])];
  const targets = views.map((v) => ({ view: v, uri: vscode.Uri.joinPath(dir, `${base}_${viewFileSuffix(session, v)}.${format}`) }));

  const existing: string[] = [];
  for (const x of targets) {
    if (await exists(x.uri)) {
      existing.push(path.basename(x.uri.fsPath));
    }
  }
  if (existing.length) {
    const list = '\n' + existing.slice(0, 10).join('\n') + (existing.length > 10 ? '\n…' : '');
    const ok = await vscode.window.showWarningMessage(
      t('ext.export.overwrite', { n: existing.length, list }),
      { modal: true },
      t('ext.export.overwriteButton')
    );
    if (!ok) {
      return;
    }
  }

  const totalRows = views.reduce((n, v) => n + session.count(v), 0) || 1;
  try {
    const summary = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('ext.export.progress', { name: base }), cancellable: true },
      async (progress, token) => {
        let records = 0;
        let unmappable = 0;
        for (const x of targets) {
          progress.report({ message: path.basename(x.uri.fsPath) });
          const share = (session.count(x.view) / totalRows) * 100;
          const r = await writeExport(session, x.view, format, x.uri, config().exportEncoding, progress, token, share);
          if (!r) {
            return undefined;
          }
          records += r.records;
          unmappable += r.unmappable;
        }
        return { records, unmappable };
      }
    );
    if (!summary) {
      vscode.window.showInformationMessage(t('ext.export.cancelled'));
      return;
    }
    await notifyExported(
      t('ext.export.doneAll', { files: targets.length, n: summary.records, dir: dir.fsPath }),
      summary.unmappable,
      targets[0].uri
    );
  } catch (e) {
    vscode.window.showErrorMessage(t('ext.export.failed', { error: (e as Error).message }));
  }
}
