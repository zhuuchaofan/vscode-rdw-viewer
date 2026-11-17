/** 打开 RDW 文件：读取（分页 / 异步扫描）、自定义编辑器、查看器面板的消息处理。 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { ByteSource, MemorySource, PagedFileSource } from '../source';
import { RdwSession, Group } from '../session';
import { RdwIndex, scanRdw, scanRdwAsync } from '../rdw';
import { Copybook } from '../copybook';
import { t, uiStrings } from '../i18n';
import { EDITOR_VIEW_TYPE, thresholds, config } from './config';
import { loadCopybook, scanCopybooks, pickCopybook, warmCopybookScan } from './copybooks';
import { layoutKey, MappingStore } from './mapping';
import { describeLayout } from './layoutReport';
import { exportView, exportAll } from './exporting';
import { pickDiscriminator } from './discriminator';
import { openCompare } from './compareView';

export interface LoadedSession {
  /** 当前的会话。逐步打开时先是文件开头一部分的会话，扫描完成后换成完整的会话 */
  readonly session: RdwSession;
  fileName: string;
  store: MappingStore;
  /** 按保存的设置重新分组、加载 copybook（作用于当前会话；与扫描完成后的替换按顺序执行） */
  applyMapping: () => Promise<void>;
  /** true = 还在后台扫描文件的其余部分，当前会话只含开头的记录 */
  readonly scanning: boolean;
  /** 扫描结束（完整会话已就绪）时为 true，取消或失败时为 false */
  readonly ready: Promise<boolean>;
  /** 后台扫描完成、会话被替换为完整会话（true），或扫描被取消 / 失败（false）时通知 */
  onDidFinishScan: (cb: (ok: boolean) => void) => vscode.Disposable;
  /** 依次执行会改变会话状态的操作，避免与扫描完成后的替换交错 */
  serial: <T>(fn: () => Promise<T> | T) => Promise<T>;
  /** 释放底层资源（分页文件描述符等）；后台扫描随之停止 */
  dispose: () => void;
}

export interface LoadOptions {
  /**
   * 允许逐步打开：大文件扫描超过 thresholds.partialAfterMs 时，先用已扫描的开头部分建立会话并返回，
   * 其余部分在后台继续扫描（自定义编辑器使用；比较等需要完整数据的场合不使用）。
   */
  progressive?: boolean;
  /** 扫描进度（0~1），仅异步扫描的大文件 */
  onProgress?: (fraction: number) => void;
}

/**
 * 读取文件，建立会话并应用保存的 copybook 设置；失败或取消时返回 undefined。
 * 本地大文件（>= 32MB）自动使用 PagedFileSource 分页按需读取，避免把数 GB 文件整块载入内存。
 */
export async function loadSession(
  ctx: vscode.ExtensionContext,
  uri: vscode.Uri,
  externalToken?: vscode.CancellationToken,
  loadOpts: LoadOptions = {}
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

  /** 文档被释放（编辑器关闭）后，后台扫描停止 */
  let disposed = false;
  /** 扫描得到的第一份结果：完整索引，或逐步打开时开头部分的快照 */
  let fullScan: Promise<RdwIndex | undefined> | undefined;
  let first: { index: RdwIndex; partial: boolean } | undefined;
  let resumeScan = () => {};
  try {
    if (source.size >= thresholds.scanProgress) {
      let onSnapshot: ((idx: RdwIndex) => Promise<void>) | undefined;
      const snapshot = new Promise<RdwIndex>((resolve) => {
        // 交出开头部分后，扫描暂停到界面用它建立好会话（resumeScan）为止
        onSnapshot = (idx) => {
          resolve(idx);
          return new Promise<void>((r) => (resumeScan = r));
        };
      });
      fullScan = new Promise<RdwIndex | undefined>((resolve, reject) => {
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('ext.openProgress', { name: fileName }),
            cancellable: true,
          },
          async (progress, token) => {
            let shown = 0;
            try {
              resolve(
                await scanRdwAsync(source, {
                  isCancelled: () =>
                    disposed ||
                    token.isCancellationRequested ||
                    // 编辑器的打开请求被取消只在返回文档之前有效
                    (!first && !!externalToken?.isCancellationRequested),
                  onProgress: (f) => {
                    loadOpts.onProgress?.(f);
                    const pct = Math.floor(f * 100);
                    if (pct > shown) {
                      progress.report({ increment: pct - shown });
                      shown = pct;
                    }
                  },
                  onSnapshot: loadOpts.progressive ? onSnapshot : undefined,
                  snapshotAfterMs: thresholds.partialAfterMs,
                  sliceMs: thresholds.scanSliceMs,
                })
              );
            } catch (e) {
              reject(e);
            }
          }
        );
      });
      const r = await Promise.race([fullScan, snapshot.then((idx) => ({ snap: idx }))]);
      if (r === undefined) {
        source.close();
        if (!externalToken?.isCancellationRequested) {
          vscode.window.showInformationMessage(t('ext.openCancelled'));
        }
        return undefined;
      }
      first = 'snap' in r ? { index: r.snap, partial: true } : { index: r, partial: false };
    } else {
      first = { index: scanRdw(source), partial: false };
    }
  } catch (e) {
    source.close();
    vscode.window.showErrorMessage(t('ext.readFailed', { error: (e as Error).message }));
    return undefined;
  }

  let current = new RdwSession(source, fileName, sessionOpts, first.index);
  const folder = vscode.workspace.getWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
  const store = new MappingStore(ctx, folder);

  // 会改变会话状态的操作按顺序执行（扫描完成后替换会话也排在其中）
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = queue.then(fn);
    queue = run.catch(() => undefined);
    return run;
  };

  /** 最近一次应用设置时读取的 copybook（扫描完成后替换会话时重复使用，不再读取文件） */
  let copybookCache = new Map<string, Promise<Copybook>>();
  const applyTo = async (activeSession: RdwSession, reuse: boolean) => {
    const prev = copybookCache;
    const cache = new Map<string, Promise<Copybook>>();
    const load = (cpyUri: vscode.Uri) => {
      const key = cpyUri.toString();
      let hit = cache.get(key) ?? (reuse ? prev.get(key) : undefined);
      if (!hit) {
        hit = loadCopybook(cpyUri);
      }
      cache.set(key, hit);
      return hit;
    };
    const loadInto = async (g: Group, stored: string | undefined, auto = false) => {
      if (!stored) {
        activeSession.setCopybook(g.length, null, undefined, g.value);
        return;
      }
      const cpyUri = auto ? vscode.Uri.parse(stored) : store.resolve(stored);
      try {
        activeSession.setCopybook(
          g.length,
          { name: path.basename(cpyUri.fsPath), copybook: await load(cpyUri) },
          undefined,
          g.value,
          auto
        );
      } catch (e) {
        activeSession.setCopybook(g.length, null, t('ext.cpyReadFailed', { path: stored, error: (e as Error).message }), g.value);
      }
    };

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
    copybookCache = cache;
  };

  const applyMapping = () => serial(() => applyTo(current, false));
  try {
    await applyMapping();
  } catch (e) {
    // 读取保存的设置失败等：会话不会交给调用方，这里负责释放文件
    disposed = true;
    current.close();
    vscode.window.showErrorMessage(t('ext.readFailed', { error: (e as Error).message }));
    return undefined;
  } finally {
    resumeScan();
  }

  let scanning = first.partial;
  const listeners = new Set<(ok: boolean) => void>();
  const finish = (ok: boolean) => {
    scanning = false;
    for (const cb of [...listeners]) cb(ok);
    listeners.clear();
    return ok;
  };
  const ready: Promise<boolean> = !first.partial
    ? Promise.resolve(true)
    : fullScan!.then(
        (index) =>
          serial(async () => {
            if (disposed) return finish(false);
            if (!index) {
              source.close();
              vscode.window.showInformationMessage(t('ext.openCancelled'));
              return finish(false);
            }
            // 沿用界面上已切换的设置（文字编码等），保存的 copybook / 判别字段设置重新应用
            const full = new RdwSession(source, fileName, { ...sessionOpts, ...current.currentOptions() }, index);
            await applyTo(full, true);
            if (disposed) return finish(false);
            current = full;
            return finish(true);
          }),
        (e) =>
          serial(() => {
            if (!disposed) {
              source.close();
              vscode.window.showErrorMessage(t('ext.readFailed', { error: (e as Error).message }));
            }
            return finish(false);
          })
      );

  return {
    get session() {
      return current;
    },
    fileName,
    store,
    applyMapping,
    get scanning() {
      return scanning;
    },
    ready,
    onDidFinishScan: (cb) => {
      if (scanning) listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    serial,
    dispose: () => {
      disposed = true;
      current.close();
    },
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
function viewerHandler(
  ctx: vscode.ExtensionContext,
  panel: vscode.WebviewPanel,
  uri: vscode.Uri,
  loaded: LoadedSession
): { handle: (msg: any) => Promise<void>; dispose: () => void } {
  const { store, applyMapping, serial } = loaded;
  const web = panel.webview;

  let gen = 0;
  /** keepSel：数据只是增加（逐步打开的扫描完成），网页保留当前选中的单元格 */
  const sendInit = (keepSel = false) => {
    gen++;
    web.postMessage({
      ...loaded.session.init(),
      scanning: loaded.scanning,
      keepSel,
      gen,
      hiddenPattern: config().hiddenPattern,
      version: String(ctx.extension.packageJSON.version ?? ''),
      strings: uiStrings(),
    });
  };

  // 逐步打开：后台扫描完成后用完整数据刷新；扫描被取消或失败则关闭编辑器
  const finished = loaded.onDidFinishScan((ok) => {
    if (ok) sendInit(true);
    else panel.dispose();
  });

  const handle = async (msg: any) => {
    const session = loaded.session;
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
        // 判别字段的取值统计需要整份文件
        if (!(await loaded.ready)) break;
        const g = loaded.session.groupByKey(msg.g);
        if (!g) break;
        const d = await pickDiscriminator(loaded.session, g);
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
        await serial(async () => {
          await store.setLayout(g.length, g.value, msg.id, option);
          loaded.session.setLayout(g.length, msg.id, option, g.value);
        });
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
        // 导出需要整份文件：逐步打开时等扫描完成
        if (await loaded.ready) await exportView(ctx, loaded.session, uri, msg.view);
        break;
      case 'exportAll':
        if (await loaded.ready) await exportAll(ctx, loaded.session, uri);
        break;
      case 'setAutoPacked':
        await serial(() => loaded.session.setAutoPacked(!!msg.on));
        sendInit();
        break;
      case 'setEncoding':
        if (await serial(() => loaded.session.setEncoding(msg.encoding))) {
          sendInit();
        }
        break;
    }
  };
  return { handle, dispose: () => finished.dispose() };
}

/**
 * 立即建立网页（显示「读取中」与进度），文件读取完成后再交给 viewerHandler。
 * 这样打开文件时编辑器不会在读取、扫描、加载 copybook 的期间一片空白。
 * 网页在读取完成前发来的消息（ready 等）先保留，完成后按顺序处理。
 */
function attachViewerPanel(ctx: vscode.ExtensionContext, panel: vscode.WebviewPanel, doc: RdwCustomDocument): vscode.Disposable {
  const web = panel.webview;
  setupWebview(ctx, web, 'main.js');
  let disposed = false;
  let inner: ReturnType<typeof viewerHandler> | undefined;
  const pending: unknown[] = [];
  let webReady = false;
  const postLoading = () => {
    if (webReady && !inner) {
      web.postMessage({ type: 'loading', fraction: doc.progress, strings: uiStrings() });
    }
  };
  const progressSub = doc.onProgress(postLoading);

  doc.loading.then(async (loaded) => {
    if (disposed) return;
    if (!loaded) {
      // 读取失败或被取消（原因已经提示过）：关闭这个编辑器
      panel.dispose();
      return;
    }
    inner = viewerHandler(ctx, panel, doc.uri, loaded);
    while (pending.length > 0 && !disposed) {
      await inner.handle(pending.shift());
    }
  });

  const sub = web.onDidReceiveMessage(async (msg) => {
    if (inner && pending.length === 0) {
      await inner.handle(msg);
      return;
    }
    if (msg?.type === 'ready') {
      webReady = true;
      postLoading();
    }
    pending.push(msg);
  });
  return {
    dispose: () => {
      disposed = true;
      progressSub.dispose();
      sub.dispose();
      inner?.dispose();
    },
  };
}

/**
 * 自定义编辑器的文档：创建时只开始读取文件、不等待完成，好让 VS Code 立即建立编辑器（网页先显示「读取中」）。
 * loading 完成后得到会话；读取失败或被取消时为 undefined。
 */
class RdwCustomDocument implements vscode.CustomDocument {
  readonly loading: Promise<LoadedSession | undefined>;
  /** 读取完成后的会话 */
  loaded: LoadedSession | undefined;
  /** 最近一次报告的扫描进度（0~1；没有进度的小文件为 undefined） */
  progress: number | undefined;
  private disposed = false;
  private readonly cancel = { isCancellationRequested: false } as vscode.CancellationToken;
  private progressListeners = new Set<() => void>();

  constructor(
    ctx: vscode.ExtensionContext,
    readonly uri: vscode.Uri
  ) {
    this.loading = loadSession(ctx, uri, this.cancel, {
      progressive: true,
      onProgress: (f) => {
        this.progress = f;
        this.progressListeners.forEach((cb) => cb());
      },
    }).then(
      (loaded) => {
        this.progressListeners.clear();
        if (loaded && this.disposed) {
          // 读取途中编辑器已经关闭
          loaded.dispose();
          return undefined;
        }
        this.loaded = loaded;
        // 在后台预先扫描工作区的 copybook，之后点击「选择 copybook」时选择框可以立即列出
        if (loaded) warmCopybookScan();
        return loaded;
      },
      (e) => {
        vscode.window.showErrorMessage(t('ext.readFailed', { error: (e as Error).message }));
        return undefined;
      }
    );
  }

  onProgress(cb: () => void): vscode.Disposable {
    this.progressListeners.add(cb);
    return { dispose: () => this.progressListeners.delete(cb) };
  }

  dispose(): void {
    this.disposed = true;
    (this.cancel as { isCancellationRequested: boolean }).isCancellationRequested = true;
    this.loaded?.dispose();
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
    _token: vscode.CancellationToken
  ): Promise<RdwCustomDocument> {
    // 不等读取完成：编辑器先显示出来（「读取中」），读取在文档内部进行
    return new RdwCustomDocument(this.ctx, uri);
  }

  async resolveCustomEditor(
    document: RdwCustomDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    const sub = attachViewerPanel(this.ctx, webviewPanel, document);
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
