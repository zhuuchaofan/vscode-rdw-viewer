import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ByteSource, MemorySource, PagedFileSource } from './source';
import { RdwSession, Discriminator, Group, discriminatorLabel, ERR_VIEW } from './session';
import { t, setLocale, uiStrings } from './i18n';
import { canExport, exportChunks, viewFileSuffix, DEFAULT_EXPORT_OPTIONS, ExportFormat } from './export';
import { encodeShiftJis } from './sjisEncode';
import { parseCopybook, copyReferences, Copybook, CopyMember } from './copybook';
import { memberFileNames, pickMember } from './copyresolve';
import { MismatchMode } from './layout';
import { CompareSession, KeyPart, MatchMode, keyLabel } from './compare';

export const EDITOR_VIEW_TYPE = 'rdwViewer.editor';
/** 各种「大文件」阈值（导出为可变对象，测试中调小以便用小文件走到大文件的路径） */
export const thresholds = {
  /** 本地文件大于该字节数时采用分页读取（不把整份文件载入内存） */
  pagedFile: 32 * 1024 * 1024,
  /** 文件大于该字节数时异步扫描并显示可取消进度通知 */
  scanProgress: 64 * 1024 * 1024,
  /** 两个文件的条目合计超过这个数时，比较在后台分批执行，显示进度并可以取消 */
  compareProgress: 200_000,
};

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

/** COPY 引用的登録集原文的查找结果（null=找不到），在一次读取（或一次扫描）中共用 */
type MemberCache = Map<string, Promise<CopyMember | null>>;

/** 一次读取中最多展开的登録集原文数（防止异常的引用关系） */
const MAX_COPY_MEMBERS = 200;

/** 查找并读取 COPY 引用的登録集原文（查找顺序见 copyresolve.ts） */
function resolveMember(name: string, library: string | undefined, baseDir: vscode.Uri, cache: MemberCache): Promise<CopyMember | null> {
  const key = `${baseDir.toString()}|${(library ?? '').toUpperCase()}|${name.toUpperCase()}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      const names = memberFileNames(name);
      const found = new Map<string, vscode.Uri>();
      // 1. 同一目录（原文名写成相对路径时也按它查找）
      for (const fn of [...new Set([name, ...names.map((n) => path.join(path.dirname(name), n))])]) {
        const uri = vscode.Uri.joinPath(baseDir, fn);
        try {
          if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.File) found.set(uri.fsPath, uri);
        } catch {
          /* 不存在 */
        }
      }
      // 2. 工作区中的同名文件
      const glob = `**/{${names.map((n) => n.replace(/[{}[\],*?]/g, '?')).join(',')}}`;
      for (const uri of await vscode.workspace.findFiles(glob, '**/{node_modules,.git,out}/**', 20)) {
        found.set(uri.fsPath, uri);
      }
      const pick = pickMember(name, library, [...found.keys()], baseDir.fsPath);
      if (!pick) {
        return null;
      }
      const rel = (f: string) => vscode.workspace.asRelativePath(found.get(f)!);
      try {
        const text = decodeCopybookText(await vscode.workspace.fs.readFile(found.get(pick.chosen)!));
        return { text, source: rel(pick.chosen), others: pick.others.map(rel) };
      } catch {
        return null;
      }
    })();
    cache.set(key, hit);
  }
  return hit;
}

/** 读取 copybook，事先找到并读取其中（含嵌套的）COPY 引用的登録集原文，然后解析 */
async function loadCopybook(uri: vscode.Uri, cache: MemberCache = new Map()): Promise<Copybook> {
  const text = decodeCopybookText(await vscode.workspace.fs.readFile(uri));
  const baseDir = vscode.Uri.joinPath(uri, '..');
  const keyOf = (name: string, library?: string) => `${(library ?? '').toUpperCase()}|${name.toUpperCase()}`;
  const members = new Map<string, CopyMember>();
  const tried = new Set<string>();
  const queue = copyReferences(text);
  while (queue.length > 0 && tried.size < MAX_COPY_MEMBERS) {
    const ref = queue.shift()!;
    const k = keyOf(ref.name, ref.library);
    if (tried.has(k)) continue;
    tried.add(k);
    const m = await resolveMember(ref.name, ref.library, baseDir, cache);
    if (m) {
      members.set(k, m);
      queue.push(...copyReferences(m.text));
    }
  }
  return parseCopybook(text, { resolve: (name, library) => members.get(keyOf(name, library)) });
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
  /** 分组（长度，或「长度=字段值」）→ REDEFINES / 01 的布局选择 */
  layouts: Record<string, Record<string, string>>;
}

/** 布局选择的保存键 */
const layoutKey = (length: number, value?: string) => (value === undefined ? String(length) : `${length}=${value}`);

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
      return { copybooks: { ...(o as Record<string, string>) }, discriminators: {}, layouts: {} };
    }
    return {
      copybooks: { ...((o.copybooks as Record<string, string>) ?? {}) },
      discriminators: { ...((o.discriminators as Record<string, StoredDiscriminator>) ?? {}) },
      layouts: { ...((o.layouts as Record<string, Record<string, string>>) ?? {}) },
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
    } else if (value === undefined) {
      // 空字符串 = 明确指定「不使用 copybook」，不再自动选择
      map[k] = '';
    } else {
      delete map[k];
    }
    await this.write(cfg);
  }

  /** 保存布局选择（option 为 undefined 时恢复默认） */
  async setLayout(length: number, value: string | undefined, id: string, option: string | undefined): Promise<void> {
    const cfg = await this.read();
    const k = layoutKey(length, value);
    const sel = { ...(cfg.layouts[k] ?? {}) };
    if (option === undefined) {
      delete sel[id];
    } else {
      sel[id] = option;
    }
    if (Object.keys(sel).length) {
      cfg.layouts[k] = sel;
    } else {
      delete cfg.layouts[k];
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
    comp5Endian: c.get<'followBinaryEndian' | 'big' | 'little'>('comp5Endian', 'little'),
    floatFormat: c.get<'ieee' | 'ibm'>('floatFormat', 'ieee'),
    autoPacked: c.get<boolean>('autoDetectPacked', true),
    exportEncoding: c.get<'shift_jis' | 'utf-8-bom'>('exportEncoding', 'shift_jis'),
  };
}

/** 工作区中的 copybook 及其总长度（无法解析的为 -1） */
async function scanCopybooks(): Promise<Array<{ uri: vscode.Uri; total: number }>> {
  const files = await vscode.workspace.findFiles(COPYBOOK_GLOB, '**/{node_modules,.git,out}/**', 500);
  const out: Array<{ uri: vscode.Uri; total: number }> = [];
  const cache: MemberCache = new Map();
  for (const uri of files) {
    let total = -1;
    try {
      total = (await loadCopybook(uri, cache)).totalLength;
    } catch {
      /* 读不了就当长度未知 */
    }
    out.push({ uri, total });
  }
  return out;
}

async function pickCopybook(length: number, store: MappingStore, value?: string): Promise<vscode.Uri | undefined> {
  interface Item extends vscode.QuickPickItem {
    uri?: vscode.Uri;
    browse?: boolean;
    match: boolean;
  }
  const items: Item[] = [];
  for (const { uri, total } of await scanCopybooks()) {
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

interface LoadedSession {
  session: RdwSession;
  fileName: string;
  store: MappingStore;
  /** 按保存的设置重新分组、加载 copybook */
  applyMapping: () => Promise<void>;
  /** 释放底层资源（分页文件描述符等） */
  dispose: () => void;
}

/**
 * 读取文件，建立会话并应用保存的 copybook 设置；失败或取消时返回 undefined。
 * 本地大文件（>= 32MB）自动使用 PagedFileSource 分页按需读取，避免把数 GB 文件整块载入内存。
 */
async function loadSession(
  ctx: vscode.ExtensionContext,
  uri: vscode.Uri,
  externalToken?: vscode.CancellationToken
): Promise<LoadedSession | undefined> {
  const fileName = path.basename(uri.fsPath);
  let source: ByteSource;
  try {
    if (uri.scheme === 'file') {
      const stat = await fs.promises.stat(uri.fsPath);
      if (stat.size >= thresholds.pagedFile) {
        source = PagedFileSource.open(uri.fsPath);
      } else {
        source = new MemorySource(await fs.promises.readFile(uri.fsPath));
      }
    } else {
      source = new MemorySource(await vscode.workspace.fs.readFile(uri));
    }
  } catch (e) {
    vscode.window.showErrorMessage(t('ext.readFailed', { error: (e as Error).message }));
    return undefined;
  }

  const cfg = config();
  const sessionOpts = {
    encoding: cfg.encoding,
    mismatch: cfg.mismatch,
    binaryEndian: cfg.binaryEndian,
    comp5Endian: cfg.comp5Endian === 'followBinaryEndian' ? undefined : cfg.comp5Endian,
    floatFormat: cfg.floatFormat,
    autoPacked: cfg.autoPacked,
  };

  let session: RdwSession | undefined;
  try {
    if (source.size >= thresholds.scanProgress) {
      session = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t('ext.openProgress', { name: fileName }),
          cancellable: true,
        },
        (progress, token) => {
          let shown = 0;
          return RdwSession.createAsync(source, fileName, sessionOpts, {
            isCancelled: () => token.isCancellationRequested || !!externalToken?.isCancellationRequested,
            onProgress: (f) => {
              const pct = Math.floor(f * 100);
              if (pct > shown) {
                progress.report({ increment: pct - shown });
                shown = pct;
              }
            },
          });
        }
      );
      if (!session) {
        source.close();
        if (!externalToken?.isCancellationRequested) {
          vscode.window.showInformationMessage(t('ext.openCancelled'));
        }
        return undefined;
      }
    } else {
      session = new RdwSession(source, fileName, sessionOpts);
    }
  } catch (e) {
    source.close();
    vscode.window.showErrorMessage(t('ext.readFailed', { error: (e as Error).message }));
    return undefined;
  }

  const activeSession = session;
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  const store = new MappingStore(ctx, folder);

  const loadInto = async (g: Group, stored: string | undefined, auto = false) => {
    if (!stored) {
      activeSession.setCopybook(g.length, null, undefined, g.value);
      return;
    }
    const cpyUri = auto ? vscode.Uri.parse(stored) : store.resolve(stored);
    try {
      activeSession.setCopybook(
        g.length,
        { name: path.basename(cpyUri.fsPath), copybook: await loadCopybook(cpyUri) },
        undefined,
        g.value,
        auto
      );
    } catch (e) {
      activeSession.setCopybook(g.length, null, t('ext.cpyReadFailed', { path: stored, error: (e as Error).message }), g.value);
    }
  };

  const applyMapping = async () => {
    const mapCfg = await store.read();
    // 先确定分组（判别字段），再为每个分组加载 copybook
    const lengths = new Set(activeSession.groups.map((g) => g.length));
    for (const len of lengths) {
      const d = mapCfg.discriminators[String(len)];
      activeSession.setDiscriminator(len, d ? { start: d.start, length: d.length, type: d.type } : null);
    }
    // 没有保存设置的长度：工作区中总长度一致的 copybook 只有一个时自动选择（不保存）
    let candidates: Array<{ uri: vscode.Uri; total: number }> | undefined;
    for (const g of [...activeSession.groups]) {
      activeSession.setLayoutSelection(g.length, mapCfg.layouts[layoutKey(g.length, g.value)] ?? {}, g.value);
      const stored =
        g.value === undefined ? mapCfg.copybooks[String(g.length)] : mapCfg.discriminators[String(g.length)]?.copybooks[g.value];
      if (stored === undefined && g.value === undefined) {
        candidates ??= await scanCopybooks();
        const hits = candidates.filter((c) => c.total === g.length);
        if (hits.length === 1) {
          await loadInto(g, hits[0].uri.toString(), true);
          continue;
        }
      }
      await loadInto(g, stored);
    }
  };
  try {
    await applyMapping();
  } catch (e) {
    // 读取保存的设置失败等：会话不会交给调用方，这里负责释放文件
    activeSession.close();
    vscode.window.showErrorMessage(t('ext.readFailed', { error: (e as Error).message }));
    return undefined;
  }
  return {
    session: activeSession,
    fileName,
    store,
    applyMapping,
    dispose: () => activeSession.close(),
  };
}

/** 配置 webview 资源权限与 HTML：先加载共用脚本 common.js，再加载 script */
function setupWebview(ctx: vscode.ExtensionContext, web: vscode.Webview, script: string): void {
  const mediaRoot = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  web.options = {
    enableScripts: true,
    localResourceRoots: [mediaRoot],
  };
  const nonce = Array.from({ length: 24 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
  const common = web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'common.js'));
  const js = web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, script));
  const css = web.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'main.css'));
  // 前端不使用行内 style 属性（列宽、行位置通过 CSSOM 设置），因此 CSP 不需要 'unsafe-inline'。
  web.html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${web.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}"><title>RDW Viewer</title></head>
<body><div id="app"></div><script nonce="${nonce}" src="${common}"></script><script nonce="${nonce}" src="${js}"></script></body></html>`;
}

/** 建立独立 webview 面板（供比较视图使用） */
function createPanel(ctx: vscode.ExtensionContext, title: string, script: string): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('rdwViewer', title, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
  });
  setupWebview(ctx, panel.webview, script);
  return panel;
}

/** 绑定单文件查看器面板的消息处理（供 Custom Editor 与命令打开共用） */
function attachViewerPanel(
  ctx: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  uri: vscode.Uri,
  loaded: LoadedSession
): vscode.Disposable {
  const { session, store, applyMapping } = loaded;
  const web = panel.webview;
  setupWebview(ctx, web, 'main.js');

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

  return web.onDidReceiveMessage(async (msg) => {
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
      case 'dump':
        web.postMessage({ type: 'dump', info: session.recordDump(Number(msg.e)) ?? null });
        break;
      case 'compare':
        await openCompare(ctx, uri);
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
      case 'setLayout': {
        const g = session.groupByKey(msg.g);
        if (!g) break;
        // 选回默认（第一个）时不必保存
        const choice = g.choices.find((c) => c.id === msg.id);
        const option = choice && choice.options[0] === msg.option ? undefined : String(msg.option);
        await store.setLayout(g.length, g.value, msg.id, option);
        session.setLayout(g.length, msg.id, option, g.value);
        sendInit();
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

class RdwCustomDocument implements vscode.CustomDocument {
  constructor(
    readonly uri: vscode.Uri,
    readonly loaded: LoadedSession
  ) {}

  dispose(): void {
    this.loaded.dispose();
  }
}

/**
 * VS Code 原生只读自定义编辑器：支持「打开方式（Open With…）」、设置默认关联、分栏以及窗口重启恢复。
 */
class RdwEditorProvider implements vscode.CustomReadonlyEditorProvider<RdwCustomDocument> {
  constructor(private readonly ctx: vscode.ExtensionContext) {}

  async openCustomDocument(
    uri: vscode.Uri,
    _openContext: vscode.CustomDocumentOpenContext,
    token: vscode.CancellationToken
  ): Promise<RdwCustomDocument> {
    const loaded = await loadSession(this.ctx, uri, token);
    if (!loaded) {
      throw vscode.CancellationError ? new vscode.CancellationError() : new Error('Cancelled');
    }
    return new RdwCustomDocument(uri, loaded);
  }

  async resolveCustomEditor(
    document: RdwCustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const sub = attachViewerPanel(this.ctx, webviewPanel, document.uri, document.loaded);
    webviewPanel.onDidDispose(() => sub.dispose());
  }
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
  await vscode.commands.executeCommand('vscode.openWith', uri, EDITOR_VIEW_TYPE);
}

/**
 * 比较用的键项目：从 A 的 copybook 字段中多选，或手动输入位置范围（例：1-3,8-10）。
 */
/**
 * 执行比较。记录多时显示进度通知、可以取消；返回 false 表示已取消（cmp 保持原来的结果）。
 */
async function runCompare(cmp: CompareSession, mode: MatchMode, keys: KeyPart[], names: string[]): Promise<boolean> {
  if (cmp.a.index.count + cmp.b.index.count < thresholds.compareProgress) {
    cmp.configure(mode, keys);
    return true;
  }
  const ok = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: t('ext.cmp.progress', { a: names[0], b: names[1] }), cancellable: true },
    (progress, token) => {
      let shown = 0;
      return cmp.configureAsync(mode, keys, {
        isCancelled: () => token.isCancellationRequested,
        onProgress: (f) => {
          const pct = Math.floor(f * 100);
          if (pct > shown) {
            progress.report({ increment: pct - shown });
            shown = pct;
          }
        },
      });
    }
  );
  if (!ok) {
    vscode.window.showInformationMessage(t('ext.cmp.cancelled'));
  }
  return ok;
}

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
async function openCompare(ctx: vscode.ExtensionContext, a?: vscode.Uri, b?: vscode.Uri): Promise<void> {
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
      case 'swap':
        await recompare(async () => {
          const next = new CompareSession(cmp.b, cmp.a, false);
          const swapped = [files[1], files[0]];
          if (await runCompare(next, cmp.mode, cmp.keys, swapped)) {
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

export function activate(ctx: vscode.ExtensionContext): void {
  setLocale(vscode.env.language);
  const provider = new RdwEditorProvider(ctx);
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('rdwViewer.open', (uri?: vscode.Uri) => openViewer(ctx, uri)),
    // エクスプローラーで 2 ファイルを選択した場合は uris に両方が入る
    vscode.commands.registerCommand('rdwViewer.compare', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      const list = (uris ?? []).filter((u) => u instanceof vscode.Uri);
      return list.length >= 2 ? openCompare(ctx, list[0], list[1]) : openCompare(ctx, uri);
    })
  );
}

export function deactivate(): void {}
