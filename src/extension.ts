import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { RdwSession, Discriminator, Group, discriminatorLabel } from './session';
import { t, setLocale, uiStrings } from './i18n';
import { canExport, exportChunks, viewFileSuffix, DEFAULT_EXPORT_OPTIONS, ExportFormat } from './export';
import { encodeShiftJis } from './sjisEncode';
import { ERR_VIEW } from './session';
import { parseCopybook, Copybook, selectRecord } from './copybook';
import { MismatchMode } from './layout';

const COPYBOOK_GLOB = '**/*.{cpy,CPY,cbl,CBL,cob,COB,copy,COPY}';
const MAPPING_FILE = ['.vscode', 'rdw-viewer.json'];
const GLOBAL_KEY = 'rdwViewer.copybooks';

/** 把 copybook 文件按 UTF-8 解码，失败则回退 Shift_JIS（日文注释常见） */
function decodeCopybookText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

async function loadCopybook(uri: vscode.Uri): Promise<Copybook> {
  return parseCopybook(decodeCopybookText(await vscode.workspace.fs.readFile(uri)));
}

interface StoredDiscriminator extends Discriminator {
  /** 字段值 → copybook 路径 */
  copybooks: Record<string, string>;
}

interface MappingConfig {
  /** 长度 → copybook 路径 */
  copybooks: Record<string, string>;
  /** 长度 → 判别字段及「字段值 → copybook」 */
  discriminators: Record<string, StoredDiscriminator>;
}

/**
 * copybook 映射的存储。
 * 有工作区时保存在 <工作区>/.vscode/rdw-viewer.json（路径相对工作区），否则保存在全局状态里（绝对路径）。
 */
class MappingStore {
  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly folder: vscode.WorkspaceFolder | undefined
  ) {}

  private get file(): vscode.Uri | undefined {
    return this.folder ? vscode.Uri.joinPath(this.folder.uri, ...MAPPING_FILE) : undefined;
  }

  private static normalize(raw: unknown): MappingConfig {
    const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    // 兼容旧版全局状态：直接保存的是「长度 → 路径」
    if (!('copybooks' in o) && !('discriminators' in o)) {
      return { copybooks: { ...(o as Record<string, string>) }, discriminators: {} };
    }
    return {
      copybooks: { ...((o.copybooks as Record<string, string>) ?? {}) },
      discriminators: { ...((o.discriminators as Record<string, StoredDiscriminator>) ?? {}) },
    };
  }

  async read(): Promise<MappingConfig> {
    const file = this.file;
    if (!file) {
      return MappingStore.normalize(this.ctx.globalState.get(GLOBAL_KEY));
    }
    try {
      return MappingStore.normalize(JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file))));
    } catch {
      return MappingStore.normalize(undefined);
    }
  }

  private async write(cfg: MappingConfig): Promise<void> {
    const file = this.file;
    if (!file) {
      await this.ctx.globalState.update(GLOBAL_KEY, cfg);
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.folder!.uri, MAPPING_FILE[0]));
    const text = JSON.stringify(cfg, null, 2) + '\n';
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
  }

  resolve(stored: string): vscode.Uri {
    if (this.folder && !path.isAbsolute(stored)) {
      return vscode.Uri.joinPath(this.folder.uri, ...stored.split(/[\\/]/));
    }
    return vscode.Uri.file(stored);
  }

  toStored(uri: vscode.Uri): string {
    if (this.folder) {
      const rel = path.relative(this.folder.uri.fsPath, uri.fsPath);
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        return rel.split(path.sep).join('/');
      }
    }
    return uri.fsPath;
  }

  /** 为分组指定/清除 copybook；value 为判别字段值（按字段值区分时） */
  async setCopybook(length: number, value: string | undefined, uri: vscode.Uri | undefined): Promise<void> {
    const cfg = await this.read();
    const map = value === undefined ? cfg.copybooks : cfg.discriminators[String(length)]?.copybooks;
    if (!map) {
      return;
    }
    const k = value === undefined ? String(length) : value;
    if (uri) {
      map[k] = this.toStored(uri);
    } else {
      delete map[k];
    }
    await this.write(cfg);
  }

  /** 设置/取消判别字段；位置和类型不变时保留已指定的 copybook */
  async setDiscriminator(length: number, d: Discriminator | null): Promise<void> {
    const cfg = await this.read();
    const k = String(length);
    if (!d) {
      delete cfg.discriminators[k];
    } else {
      const cur = cfg.discriminators[k];
      const same = cur && cur.start === d.start && cur.length === d.length && cur.type === d.type;
      cfg.discriminators[k] = { start: d.start, length: d.length, type: d.type, copybooks: same ? cur.copybooks : {} };
    }
    await this.write(cfg);
  }
}

function config() {
  const c = vscode.workspace.getConfiguration('rdwViewer');
  return {
    encoding: c.get<string>('encoding', 'shift_jis'),
    mismatch: c.get<MismatchMode>('lengthMismatch', 'lenient'),
    hiddenPattern: c.get<string>('hiddenFieldPattern', '^FILLER$'),
    binaryEndian: c.get<'big' | 'little'>('binaryEndian', 'big'),
    autoPacked: c.get<boolean>('autoDetectPacked', true),
    exportEncoding: c.get<'shift_jis' | 'utf-8-bom'>('exportEncoding', 'shift_jis'),
  };
}

async function pickCopybook(length: number, store: MappingStore, value?: string): Promise<vscode.Uri | undefined> {
  interface Item extends vscode.QuickPickItem {
    uri?: vscode.Uri;
    browse?: boolean;
    match: boolean;
  }
  const files = await vscode.workspace.findFiles(COPYBOOK_GLOB, '**/{node_modules,.git,out}/**', 500);
  const items: Item[] = [];
  for (const uri of files) {
    let total = -1;
    try {
      total = (await loadCopybook(uri)).totalLength;
    } catch {
      /* 读不了就当长度未知 */
    }
    const match = total === length;
    items.push({
      label: `${match ? '$(check) ' : ''}${path.basename(uri.fsPath)}`,
      description: vscode.workspace.asRelativePath(uri, false),
      detail: total >= 0 ? t(match ? 'ext.cpyDetailMatch' : 'ext.cpyDetail', { n: total }) : t('ext.cpyUnparsable'),
      uri,
      match,
    });
  }
  items.sort((a, b) => Number(b.match) - Number(a.match) || a.label.localeCompare(b.label));
  items.push({ label: t('ext.browse'), browse: true, match: false });

  const picked = await vscode.window.showQuickPick(items, {
    title: value === undefined ? t('ext.pickTitle', { len: length }) : t('ext.pickTitleValue', { len: length, value }),
    placeHolder: t('ext.pickPlaceholder'),
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.browse) {
    const res = await vscode.window.showOpenDialog({
      canSelectMany: false,
      title: t('ext.openDialogTitle', { len: length }),
      filters: { Copybook: ['cpy', 'cbl', 'cob', 'copy'], [t('ext.allFiles')]: ['*'] },
    });
    return res?.[0];
  }
  return picked.uri;
}

/** 生成「解析详情」文本：copybook 中每个字段的位置、长度，便于和 copybook 原文对照 */
function describeLayout(session: RdwSession, g: Group): string {
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
  const rec = selectRecord(cb, length);
  if (rec) {
    lines.push(t('ext.layout.selected', { name: rec.name, len: rec.totalLength, n: rec.fields.length }));
    if (rec.totalLength !== length) {
      lines.push(t(rec.totalLength > length ? 'ext.layout.diffMore' : 'ext.layout.diffLess', { n: Math.abs(rec.totalLength - length) }));
    }
  }
  if (cb.warnings.length) {
    lines.push('', t('ext.layout.warnings'));
    cb.warnings.forEach((w) => lines.push(`  - ${w}`));
  }
  if (rec) {
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
    rec.fields.forEach((f, i) => {
      lines.push(
        [
          String(i + 1).padStart(5),
          String(f.offset + 1).padStart(6),
          String(f.length).padStart(6),
          String(f.offset + f.length).padStart(6),
          ('  ' + f.pic).padEnd(26),
          f.name,
        ].join(' ')
      );
    });
  }
  return lines.join('\n') + '\n';
}

const LAST_FORMAT_KEY = 'rdwViewer.lastExportFormat';

/** 选择导出格式（记住上次的选择） */
async function pickExportFormat(ctx: vscode.ExtensionContext): Promise<ExportFormat | undefined> {
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
  const opts = { ...DEFAULT_EXPORT_OPTIONS, format };
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
    for (const chunk of exportChunks(session, view, opts)) {
      if (token.isCancellationRequested) {
        return undefined;
      }
      const r = encode(chunk.text);
      unmappable += r.unmappable;
      fd ? await fd.write(r.bytes) : parts.push(r.bytes);
      records = chunk.done;
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
async function notifyExported(message: string, unmappable: number, target: vscode.Uri): Promise<void> {
  const text = unmappable ? `${message} ${t('ext.export.unmappable', { n: unmappable })}` : message;
  const show = unmappable ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
  const btn = await show(text, t('ext.export.reveal'));
  if (btn) {
    await vscode.commands.executeCommand('revealFileInOS', target);
  }
}

/** 导出当前标签页 */
async function exportView(ctx: vscode.ExtensionContext, session: RdwSession, dataUri: vscode.Uri, view: string): Promise<void> {
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
async function exportAll(ctx: vscode.ExtensionContext, session: RdwSession, dataUri: vscode.Uri): Promise<void> {
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

const MAX_DISC_VALUES = 50;

/**
 * 「按字段值区分」：选择判别字段（从当前 copybook 的字段中选，或手动输入位置/长度/类型），
 * 预览各值的条数，确认后返回判别字段。
 */
async function pickDiscriminator(session: RdwSession, g: Group): Promise<Discriminator | undefined> {
  interface Item extends vscode.QuickPickItem {
    d?: Discriminator;
    manual?: boolean;
  }
  const items: Item[] = [];
  if (g.copybook) {
    const rec = selectRecord(g.copybook.copybook, g.length);
    for (const f of rec?.fields ?? []) {
      if (f.offset + f.length > g.length) {
        continue;
      }
      const type = f.usage === 'COMP-3' || f.usage === 'PACKED-DECIMAL' ? 'comp3' : 'text';
      items.push({
        label: f.name,
        description: t('ext.disc.fieldDesc', { pos: f.offset + 1, len: f.length, pic: f.pic }),
        d: { start: f.offset + 1, length: f.length, type },
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

async function openViewer(ctx: vscode.ExtensionContext, target?: vscode.Uri): Promise<void> {
  let uri = target;
  if (!uri) {
    const res = await vscode.window.showOpenDialog({ canSelectMany: false, title: t('ext.selectRdwFile') });
    uri = res?.[0];
  }
  if (!uri) {
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (e) {
    vscode.window.showErrorMessage(t('ext.readFailed', { error: (e as Error).message }));
    return;
  }

  const cfg = config();
  const fileName = path.basename(uri.fsPath);
  const session = new RdwSession(bytes, fileName, {
    encoding: cfg.encoding,
    mismatch: cfg.mismatch,
    binaryEndian: cfg.binaryEndian,
    autoPacked: cfg.autoPacked,
  });
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  const store = new MappingStore(ctx, folder);

  const loadInto = async (g: Group, stored: string | undefined) => {
    if (!stored) {
      session.setCopybook(g.length, null, undefined, g.value);
      return;
    }
    const cpyUri = store.resolve(stored);
    try {
      session.setCopybook(
        g.length,
        { name: path.basename(cpyUri.fsPath), copybook: await loadCopybook(cpyUri) },
        undefined,
        g.value
      );
    } catch (e) {
      session.setCopybook(g.length, null, t('ext.cpyReadFailed', { path: stored, error: (e as Error).message }), g.value);
    }
  };

  const applyMapping = async () => {
    const cfg = await store.read();
    // 先确定分组（判别字段），再为每个分组加载 copybook
    const lengths = new Set(session.groups.map((g) => g.length));
    for (const len of lengths) {
      const d = cfg.discriminators[String(len)];
      session.setDiscriminator(len, d ? { start: d.start, length: d.length, type: d.type } : null);
    }
    for (const g of [...session.groups]) {
      const stored =
        g.value === undefined ? cfg.copybooks[String(g.length)] : cfg.discriminators[String(g.length)]?.copybooks[g.value];
      await loadInto(g, stored);
    }
  };
  await applyMapping();

  const mediaRoot = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel('rdwViewer', `RDW: ${fileName}`, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaRoot],
  });
  const web = panel.webview;
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const js = web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.js'));
  const css = web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
  // 前端不使用行内 style 属性（列宽、行位置通过 CSSOM 设置），因此 CSP 不需要 'unsafe-inline'。
  web.html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>RDW Viewer</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${js}"></script></body></html>`;

  let gen = 0;
  const sendInit = () => {
    gen++;
    web.postMessage({
      ...session.init(),
      gen,
      hiddenPattern: config().hiddenPattern,
      version: String(ctx.extension.packageJSON.version ?? ''),
      strings: uiStrings(),
    });
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
          view: msg.view,
          start: msg.start,
          rows: session.getRows(msg.view, msg.start, msg.count),
        });
        break;
      case 'cellInfo':
        web.postMessage({ type: 'cell', info: session.cellInfo(msg.g, msg.e, msg.col) ?? null });
        break;
      case 'chooseCopybook': {
        const g = session.groupByKey(msg.g);
        if (!g) break;
        const picked = await pickCopybook(g.length, store, g.value);
        if (picked) {
          await store.setCopybook(g.length, g.value, picked);
          await applyMapping();
          sendInit();
        }
        break;
      }
      case 'showLayout': {
        const g = session.groupByKey(msg.g);
        if (!g) break;
        const doc = await vscode.workspace.openTextDocument({ content: describeLayout(session, g), language: 'plaintext' });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        break;
      }
      case 'clearCopybook': {
        const g = session.groupByKey(msg.g);
        if (!g) break;
        await store.setCopybook(g.length, g.value, undefined);
        await applyMapping();
        sendInit();
        break;
      }
      case 'configureDisc': {
        const g = session.groupByKey(msg.g);
        if (!g) break;
        const d = await pickDiscriminator(session, g);
        if (d) {
          await store.setDiscriminator(g.length, d);
          await applyMapping();
          sendInit();
        }
        break;
      }
      case 'clearDisc': {
        const g = session.groupByKey(msg.g);
        if (!g) break;
        const ok = await vscode.window.showWarningMessage(
          t('ext.disc.clearConfirm', { len: g.length }),
          { modal: true },
          t('ext.disc.clearButton')
        );
        if (ok) {
          await store.setDiscriminator(g.length, null);
          await applyMapping();
          sendInit();
        }
        break;
      }
      case 'exportView':
        await exportView(ctx, session, uri, msg.view);
        break;
      case 'exportAll':
        await exportAll(ctx, session, uri);
        break;
      case 'setAutoPacked':
        session.setAutoPacked(!!msg.on);
        sendInit();
        break;
      case 'setEncoding':
        if (session.setEncoding(msg.encoding)) {
          sendInit();
        }
        break;
    }
  });
}

export function activate(ctx: vscode.ExtensionContext): void {
  setLocale(vscode.env.language);
  ctx.subscriptions.push(
    vscode.commands.registerCommand('rdwViewer.open', (uri?: vscode.Uri) => openViewer(ctx, uri))
  );
}

export function deactivate(): void {}
