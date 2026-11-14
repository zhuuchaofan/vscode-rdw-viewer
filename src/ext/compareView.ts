/** 两个文件的比较面板：执行比较（进度、取消）、键项目、忽略字段、差异报告。 */
import * as vscode from 'vscode';
import * as path from 'path';
import { t, uiStrings } from '../i18n';
import { CompareSession, KeyPart, MatchMode, fieldBase, keyLabel } from '../compare';
import { diffReportChunks } from '../compareReport';
import { thresholds, config } from './config';
import { pickExportFormat, writeChunks, notifyExported } from './exporting';
import { loadSession, createPanel } from './viewer';

/**
 * 执行比较。记录多时显示进度通知、可以取消；返回 false 表示已取消（cmp 保持原来的结果）。
 */
async function runCompare(cmp: CompareSession, mode: MatchMode, keys: KeyPart[], names: string[], ignore: string[] = cmp.ignore): Promise<boolean> {
  if (cmp.a.index.count + cmp.b.index.count < thresholds.compareProgress) {
    cmp.configure(mode, keys, ignore);
    return true;
  }
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('ext.cmp.progress', { a: names[0], b: names[1] }), cancellable: true },
    (progress, token) => {
      let shown = 0;
      return cmp.configureAsync(
        mode,
        keys,
        {
          isCancelled: () => token.isCancellationRequested,
          onProgress: (f) => {
            const pct = Math.floor(f * 100);
            if (pct > shown) {
              progress.report({ increment: pct - shown });
              shown = pct;
            }
          },
        },
        ignore
      );
    }
  );
  if (!ok) {
    vscode.window.showInformationMessage(t('ext.cmp.cancelled'));
  }
  return ok;
}

/**
 * 比较用的键项目：从 A 的 copybook 字段中多选，或手动输入位置范围（例：1-3,8-10）。
 */
async function pickCompareKey(cmp: CompareSession): Promise<KeyPart[] | undefined> {
  interface Item extends vscode.QuickPickItem {
    part?: KeyPart;
    manual?: boolean;
  }
  const seen = new Map<string, Item & { lens: number[] }>();
  for (const g of cmp.a.groups) {
    if (!g.copybook) continue;
    for (const c of g.columns.filter((x) => x.kind === 'field')) {
      const k = `${c.name}|${c.start}|${c.len}`;
      const hit = seen.get(k);
      if (hit) {
        hit.lens.push(g.length);
        continue;
      }
      seen.set(k, { label: c.name, part: { start: c.start, length: c.len }, lens: [g.length], description: c.pic });
    }
  }
  const items: Item[] = [...seen.values()].map((x) => ({
    label: x.label,
    part: x.part,
    description: t('ext.cmp.fieldDesc', { pos: x.part!.start, len: x.part!.length, pic: x.description ?? '', lens: x.lens.join('/') }),
  }));
  let parts: KeyPart[] = [];
  let manual = items.length === 0;
  if (!manual) {
    items.push({ label: t('ext.cmp.manual'), manual: true });
    const picked = await vscode.window.showQuickPick(items, {
      title: t('ext.cmp.keyTitle'),
      placeHolder: t('ext.cmp.keyPlaceholder'),
      canPickMany: true,
      matchOnDescription: true,
    });
    if (!picked || picked.length === 0) {
      return undefined;
    }
    manual = picked.some((x) => x.manual);
    parts = picked.filter((x) => x.part).map((x) => x.part!);
  }
  if (manual) {
    const parse = (v: string): KeyPart[] | undefined => {
      const out: KeyPart[] = [];
      for (const piece of v.split(/[,，、\s]+/).filter(Boolean)) {
        const m = /^(\d+)(?:[-~](\d+))?$/.exec(piece);
        if (!m) return undefined;
        const from = +m[1];
        const to = m[2] ? +m[2] : from;
        if (from < 1 || to < from || to > 65535) return undefined;
        out.push({ start: from, length: to - from + 1 });
      }
      return out.length ? out : undefined;
    };
    const text = await vscode.window.showInputBox({
      title: t('ext.cmp.manualTitle'),
      prompt: t('ext.cmp.manualPrompt'),
      placeHolder: '1-10',
      validateInput: (v) => (parse(v) ? undefined : t('ext.cmp.manualInvalid')),
    });
    if (!text) {
      return undefined;
    }
    parts = parts.concat(parse(text)!);
  }
  return parts;
}

/** 两个文件的比较。a / b 省略时用对话框选择 */
/** 比较时忽略的字段：从 A、B 两边的字段中多选（OCCURS 的各次出现合为一项） */
async function pickIgnoredFields(cmp: CompareSession): Promise<string[] | undefined> {
  const names = new Map<string, string>();
  for (const s of [cmp.a, cmp.b]) {
    for (const g of s.groups) {
      for (const c of g.columns) {
        if (c.kind !== 'body' && c.kind !== 'extra') names.set(fieldBase(c.name), c.name.replace(/\(.*\)$/, ''));
      }
    }
  }
  const current = new Set(cmp.ignore);
  const items = [...names].map(([key, label]) => ({ label, key, picked: current.has(key) }));
  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: t('ext.cmp.ignoreTitle'),
    placeHolder: t('ext.cmp.ignorePlaceholder'),
  });
  return picked?.map((x) => x.key);
}

/** 把差异导出为 CSV / TSV */
async function exportDiffReport(ctx: vscode.ExtensionContext, cmp: CompareSession, dataUri: vscode.Uri, files: string[]): Promise<void> {
  const format = await pickExportFormat(ctx);
  if (!format) {
    return;
  }
  const stem = (f: string) => f.replace(/\.[^.]*$/, '');
  const target = await vscode.window.showSaveDialog({
    title: t('ext.cmp.reportSaveTitle'),
    defaultUri: vscode.Uri.joinPath(dataUri, '..', `${stem(files[0])}_vs_${stem(files[1])}_diff.${format}`),
    filters: { [format.toUpperCase()]: [format] },
  });
  if (!target) {
    return;
  }
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('ext.cmp.reportProgress', { name: path.basename(target.fsPath) }), cancellable: true },
      (progress, token) => writeChunks(diffReportChunks(cmp, format), target, config().exportEncoding, progress, token, 100)
    );
    if (!result) {
      vscode.window.showInformationMessage(t('ext.export.cancelled'));
      return;
    }
    await notifyExported(t('ext.cmp.reportDone', { n: result.records, path: target.fsPath }), result.unmappable, target);
  } catch (e) {
    vscode.window.showErrorMessage(t('ext.export.failed', { error: (e as Error).message }));
  }
}

export async function openCompare(ctx: vscode.ExtensionContext, a?: vscode.Uri, b?: vscode.Uri): Promise<void> {
  if (!a) {
    a = (await vscode.window.showOpenDialog({ canSelectMany: false, title: t('ext.cmp.pickA') }))?.[0];
    if (!a) return;
  }
  if (!b) {
    b = (
      await vscode.window.showOpenDialog({
        canSelectMany: false,
        title: t('ext.cmp.pickB', { name: path.basename(a.fsPath) }),
        defaultUri: vscode.Uri.joinPath(a, '..'),
      })
    )?.[0];
    if (!b) return;
  }
  const la = await loadSession(ctx, a);
  if (!la) {
    return;
  }
  const lb = await loadSession(ctx, b);
  if (!lb) {
    // B 打不开 / 取消：A 已经打开，必须释放
    la.dispose();
    return;
  }
  // 从这里开始，两个会话（大文件时各持有一个文件描述符）由比较面板负责释放；
  // 面板建立之前的任何退出路径（取消、异常）都在这里释放
  const disposeBoth = () => {
    la.dispose();
    lb.dispose();
  };
  let cmp: CompareSession;
  let files = [la.fileName, lb.fileName];
  let panel: vscode.WebviewPanel;
  try {
    cmp = new CompareSession(la.session, lb.session, false);
    if (!(await runCompare(cmp, 'index', [], files))) {
      disposeBoth();
      return;
    }
    panel = createPanel(ctx, `RDW: ${la.fileName} ⇄ ${lb.fileName}`, 'compare.js');
  } catch (e) {
    disposeBoth();
    throw e;
  }
  // 交换 A / B 只是调换同一对会话，不会重新打开文件，所以关闭面板时释放这两个即可
  panel.onDidDispose(disposeBoth);
  const web = panel.webview;

  let gen = 0;
  const sendInit = () => {
    gen++;
    web.postMessage({
      ...cmp.init(),
      gen,
      fileA: files[0],
      fileB: files[1],
      keyLabel: keyLabel(cmp.keys),
      hiddenPattern: config().hiddenPattern,
      version: String(ctx.extension.packageJSON.version ?? ''),
      strings: uiStrings(),
    });
  };

  // 重新比较的途中（大文件时为异步）不接受另一次重新比较；显示用的请求照常处理（结果在算完后才替换）
  let busy = false;
  const recompare = async (fn: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } finally {
      busy = false;
    }
  };

  web.onDidReceiveMessage(async (msg) => {
    switch (msg.type) {
      case 'ready':
        sendInit();
        break;
      case 'getRows':
        web.postMessage({
          type: 'rows',
          gen: msg.gen,
          d: !!msg.d,
          start: msg.start,
          rows: cmp.getRows(!!msg.d, msg.start, msg.count),
        });
        break;
      case 'cellInfo':
        web.postMessage({ type: 'cell', p: msg.p, info: cmp.cellPair(msg.p, msg.side === 'b' ? 'b' : 'a', msg.col) });
        break;
      case 'dump':
        web.postMessage({ type: 'dump', p: msg.p, info: cmp.dumpPair(msg.p) });
        break;
      case 'findDiff':
        web.postMessage({ type: 'found', i: cmp.findDiff(!!msg.d, msg.from, msg.dir < 0 ? -1 : 1), dir: msg.dir });
        break;
      case 'chooseKey':
        await recompare(async () => {
          const keys = await pickCompareKey(cmp);
          if (keys) {
            await runCompare(cmp, 'key', keys, files);
          }
          sendInit();
        });
        break;
      case 'setIndex':
        await recompare(async () => {
          await runCompare(cmp, 'index', [], files);
          sendInit();
        });
        break;
      case 'chooseIgnore':
        await recompare(async () => {
          const ignore = await pickIgnoredFields(cmp);
          if (ignore) {
            await runCompare(cmp, cmp.mode, cmp.keys, files, ignore);
          }
          sendInit();
        });
        break;
      case 'exportDiff':
        await exportDiffReport(ctx, cmp, a!, files);
        break;
      case 'swap':
        await recompare(async () => {
          const next = new CompareSession(cmp.b, cmp.a, false);
          const swapped = [files[1], files[0]];
          if (await runCompare(next, cmp.mode, cmp.keys, swapped, cmp.ignore)) {
            cmp = next;
            files = swapped;
            panel.title = `RDW: ${files[0]} ⇄ ${files[1]}`;
          }
          sendInit();
        });
        break;
    }
  });
}
