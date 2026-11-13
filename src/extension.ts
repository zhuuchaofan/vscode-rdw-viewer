import * as vscode from 'vscode';
import * as path from 'path';
import { RdwSession } from './session';
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

/**
 * 「长度 → copybook 路径」的映射存储。
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

  async read(): Promise<Record<string, string>> {
    const file = this.file;
    if (!file) {
      return { ...(this.ctx.globalState.get<Record<string, string>>(GLOBAL_KEY) ?? {}) };
    }
    try {
      const json = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
      return { ...(json.copybooks ?? {}) };
    } catch {
      return {};
    }
  }

  private async write(map: Record<string, string>): Promise<void> {
    const file = this.file;
    if (!file) {
      await this.ctx.globalState.update(GLOBAL_KEY, map);
      return;
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.folder!.uri, MAPPING_FILE[0]));
    const text = JSON.stringify({ copybooks: map }, null, 2) + '\n';
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

  async set(length: number, uri: vscode.Uri | undefined): Promise<void> {
    const map = await this.read();
    if (uri) {
      map[String(length)] = this.toStored(uri);
    } else {
      delete map[String(length)];
    }
    await this.write(map);
  }
}

function config() {
  const c = vscode.workspace.getConfiguration('rdwViewer');
  return {
    encoding: c.get<string>('encoding', 'shift_jis'),
    mismatch: c.get<MismatchMode>('lengthMismatch', 'lenient'),
    hiddenPattern: c.get<string>('hiddenFieldPattern', '^FILLER$'),
    binaryEndian: c.get<'big' | 'little'>('binaryEndian', 'big'),
  };
}

async function pickCopybook(length: number, store: MappingStore): Promise<vscode.Uri | undefined> {
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
    title: `为长度 ${length} 的记录选择 copybook`,
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
function describeLayout(session: RdwSession, length: number): string {
  const g = session.groups.find((x) => x.length === length);
  if (!g || !g.copybook) {
    return `长度 ${length} 尚未指定 copybook。`;
  }
  const cb = g.copybook.copybook;
  const lines: string[] = [];
  lines.push(`copybook   : ${g.copybook.name}`);
  lines.push(`记录长度   : ${length} 字节`);
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
  const session = new RdwSession(bytes, fileName, { encoding: cfg.encoding, mismatch: cfg.mismatch, binaryEndian: cfg.binaryEndian });
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  const store = new MappingStore(ctx, folder);

  const applyMapping = async () => {
    const map = await store.read();
    for (const g of session.groups) {
      const stored = map[String(g.length)];
      if (!stored) {
        session.setCopybook(g.length, null);
        continue;
      }
      const cpyUri = store.resolve(stored);
      try {
        session.setCopybook(g.length, { name: path.basename(cpyUri.fsPath), copybook: await loadCopybook(cpyUri) });
      } catch (e) {
        session.setCopybook(g.length, null, `无法读取 copybook「${stored}」：${(e as Error).message}`);
      }
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
        const picked = await pickCopybook(msg.length, store);
        if (picked) {
          await store.set(msg.length, picked);
          await applyMapping();
          sendInit();
        }
        break;
      }
      case 'showLayout': {
        const doc = await vscode.workspace.openTextDocument({
          content: describeLayout(session, msg.length),
          language: 'plaintext',
        });
        await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
        break;
      }
      case 'clearCopybook':
        await store.set(msg.length, undefined);
        await applyMapping();
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
