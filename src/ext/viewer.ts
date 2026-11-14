/** 打开 RDW 文件：读取（分页 / 异步扫描）、自定义编辑器、查看器面板的消息处理。 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ByteSource, MemorySource, PagedFileSource } from '../source';
import { RdwSession, Group } from '../session';
import { t, uiStrings } from '../i18n';
import { EDITOR_VIEW_TYPE, thresholds, config } from './config';
import { loadCopybook, scanCopybooks, pickCopybook } from './copybooks';
import { layoutKey, MappingStore } from './mapping';
import { describeLayout } from './layoutReport';
import { exportView, exportAll } from './exporting';
import { pickDiscriminator } from './discriminator';
import { openCompare } from './compareView';

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
export async function loadSession(
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
export function createPanel(ctx: vscode.ExtensionContext, title: string, script: string): vscode.WebviewPanel {
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
export class RdwEditorProvider implements vscode.CustomReadonlyEditorProvider<RdwCustomDocument> {
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

export async function openViewer(ctx: vscode.ExtensionContext, target?: vscode.Uri): Promise<void> {
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
