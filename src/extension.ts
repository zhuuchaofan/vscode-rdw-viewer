import * as vscode from 'vscode';
import * as path from 'path';
import { RdwSession, Discriminator, Group } from './session';
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
      detail: total >= 0 ? `总长 ${total} 字节${match ? '，与记录长度一致' : ''}` : '无法解析',
      uri,
      match,
    });
  }
  items.sort((a, b) => Number(b.match) - Number(a.match) || a.label.localeCompare(b.label));
  items.push({ label: '$(folder-opened) 浏览其他文件…', browse: true, match: false });

  const picked = await vscode.window.showQuickPick(items, {
    title: value === undefined ? `为长度 ${length} 的记录选择 copybook` : `为长度 ${length}、字段值 ${value} 的记录选择 copybook`,
    placeHolder: '带 ✓ 的 copybook 总长度与记录长度一致',
    matchOnDescription: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.browse) {
    const res = await vscode.window.showOpenDialog({
      canSelectMany: false,
      title: `选择长度 ${length} 对应的 copybook`,
      filters: { Copybook: ['cpy', 'cbl', 'cob', 'copy'], 全部文件: ['*'] },
    });
    return res?.[0];
  }
  return picked.uri;
}

/** 生成「解析详情」文本：copybook 中每个字段的位置、长度，便于和 copybook 原文对照 */
function describeLayout(session: RdwSession, g: Group): string {
  const length = g.length;
  if (!g.copybook) {
    return `长度 ${length} 尚未指定 copybook。`;
  }
  const cb = g.copybook.copybook;
  const lines: string[] = [];
  lines.push(`copybook   : ${g.copybook.name}`);
  lines.push(`记录长度   : ${length} 字节`);
  const disc = session.getDiscriminator(length);
  if (g.value !== undefined && disc) {
    lines.push(`判别字段   : 位置 ${disc.start}~${disc.start + disc.length - 1}（${disc.type === 'comp3' ? 'COMP-3' : '文字'}） = ${g.value}`);
  }
  lines.push(`01 定义    : ${cb.records.map((r) => `${r.name}（${r.totalLength} 字节）`).join('、') || '（无）'}`);
  const rec = selectRecord(cb, length);
  if (rec) {
    lines.push(`选用       : ${rec.name}，总长 ${rec.totalLength} 字节，${rec.fields.length} 个字段`);
    if (rec.totalLength !== length) {
      lines.push(`差异       : ${rec.totalLength > length ? 'copybook 多' : 'copybook 少'} ${Math.abs(rec.totalLength - length)} 字节`);
    }
  }
  if (cb.warnings.length) {
    lines.push('', '解析提示:');
    cb.warnings.forEach((w) => lines.push(`  - ${w}`));
  }
  if (rec) {
    lines.push('', ['No.'.padStart(5), '位置'.padStart(6), '长度'.padStart(6), '结束'.padStart(6), '  属性'.padEnd(26), '字段名'].join(' '));
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
        description: `位置 ${f.offset + 1} · ${f.length} 字节 · ${f.pic}`,
        d: { start: f.offset + 1, length: f.length, type },
      });
    }
  }
  items.push({ label: '$(edit) 手动输入位置和长度…', manual: true });

  const pick = await vscode.window.showQuickPick(items, {
    title: `长度 ${g.length}：选择用来区分 copybook 的字段`,
    placeHolder: g.copybook ? `字段来自「${g.copybook.name}」` : '尚未指定 copybook，请手动输入位置和长度',
    matchOnDescription: true,
  });
  if (!pick) {
    return undefined;
  }
  let d = pick.d;
  if (pick.manual) {
    const num = (min: number, max: number) => (v: string) =>
      /^\d+$/.test(v.trim()) && +v >= min && +v <= max ? undefined : `请输入 ${min}~${max} 的整数`;
    const start = await vscode.window.showInputBox({
      title: '判别字段的起始位置',
      prompt: `从 1 开始计数（记录正文共 ${g.length} 字节）`,
      value: '1',
      validateInput: num(1, g.length),
    });
    if (!start) return undefined;
    const len = await vscode.window.showInputBox({
      title: '判别字段的长度（字节）',
      value: '1',
      validateInput: num(1, Math.min(16, g.length - +start + 1)),
    });
    if (!len) return undefined;
    const type = await vscode.window.showQuickPick(
      [
        { label: '文字', description: '按字符比较，如 01、HD', t: 'text' as const },
        { label: 'COMP-3', description: '按数值比较，如 11 80 0C → +11800', t: 'comp3' as const },
      ],
      { title: '判别字段的类型' }
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
      `该字段在长度 ${g.length} 的记录中有 ${values.length} 种不同的值，可能选错了字段，已取消。`
    );
    return undefined;
  }
  interface Confirm extends vscode.QuickPickItem {
    ok?: boolean;
  }
  const confirm = await vscode.window.showQuickPick<Confirm>(
    [
      { label: `$(check) 按此字段区分为 ${values.length} 组`, ok: true },
      { label: '各值的记录数', kind: vscode.QuickPickItemKind.Separator },
      ...values.map((v) => ({ label: v.value, description: `${v.count} 条` })),
    ],
    { title: `位置 ${d.start}~${d.start + d.length - 1}（${d.type === 'comp3' ? 'COMP-3' : '文字'}）的取值` }
  );
  return confirm?.ok ? d : undefined;
}

async function openViewer(ctx: vscode.ExtensionContext, target?: vscode.Uri): Promise<void> {
  let uri = target;
  if (!uri) {
    const res = await vscode.window.showOpenDialog({ canSelectMany: false, title: '选择 RDW 记录文件' });
    uri = res?.[0];
  }
  if (!uri) {
    return;
  }

  let bytes: Uint8Array;
  try {
    bytes = await vscode.workspace.fs.readFile(uri);
  } catch (e) {
    vscode.window.showErrorMessage(`读取文件失败：${(e as Error).message}`);
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
      session.setCopybook(g.length, null, `无法读取 copybook「${stored}」：${(e as Error).message}`, g.value);
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
          `取消长度 ${g.length} 的「按字段值区分」？各字段值对应的 copybook 设置也会被清除。`,
          { modal: true },
          '取消区分'
        );
        if (ok) {
          await store.setDiscriminator(g.length, null);
          await applyMapping();
          sendInit();
        }
        break;
      }
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
  ctx.subscriptions.push(
    vscode.commands.registerCommand('rdwViewer.open', (uri?: vscode.Uri) => openViewer(ctx, uri))
  );
}

export function deactivate(): void {}
