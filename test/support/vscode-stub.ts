/**
 * 测试用的最小 `vscode` 替身：只实现 src/extension.ts 在打开 / 关闭 / 比较流程中用到的 API，
 * 让自定义编辑器和比较面板的生命周期可以直接用 node --test 验证（不启动 VS Code）。
 * 这里不验证界面，只验证扩展侧的资源管理：文件何时打开、何时释放。
 */
import * as nodeFs from 'fs';
import * as nodePath from 'path';

type Listener<T> = (e: T) => unknown;
const disposable = (fn: () => void = () => {}) => ({ dispose: fn });

export class Uri {
  private constructor(
    readonly scheme: string,
    readonly fsPath: string
  ) {}
  get path(): string {
    return this.fsPath;
  }
  static file(p: string): Uri {
    return new Uri('file', p);
  }
  static parse(s: string): Uri {
    return new Uri('file', s.replace(/^file:\/\//, ''));
  }
  static joinPath(base: Uri, ...segs: string[]): Uri {
    return new Uri(base.scheme, nodePath.join(base.fsPath, ...segs));
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
  }
}

export class CancellationError extends Error {}
export const ProgressLocation = { Notification: 15 };
export const ViewColumn = { Active: -1, Beside: -2 };
export const QuickPickItemKind = { Separator: -1 };
export const env = { language: 'ja' };
export const FileType = { File: 1, Directory: 2 };

export class FakePanel {
  title = '';
  disposed = false;
  readonly posted: Array<{ type?: string }> = [];
  private disposeListeners: Array<Listener<void>> = [];
  private messageListeners: Array<Listener<unknown>> = [];
  readonly webview = {
    options: {} as unknown,
    html: '',
    cspSource: 'stub:',
    asWebviewUri: (u: Uri) => u,
    postMessage: async (m: { type?: string }) => {
      this.posted.push(m);
      return true;
    },
    onDidReceiveMessage: (cb: Listener<unknown>) => {
      this.messageListeners.push(cb);
      return disposable(() => {
        this.messageListeners = this.messageListeners.filter((x) => x !== cb);
      });
    },
  };
  onDidDispose(cb: Listener<void>) {
    this.disposeListeners.push(cb);
    return disposable();
  }
  /** 模拟 webview 发来的消息 */
  async receive(msg: unknown): Promise<void> {
    for (const cb of [...this.messageListeners]) {
      await cb(msg);
    }
  }
  /** 模拟用户关闭标签页 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposeListeners.forEach((cb) => cb());
  }
}

/** 测试可以读取 / 设置的状态 */
export const state = {
  panels: [] as FakePanel[],
  errors: [] as string[],
  infos: [] as string[],
  commands: new Map<string, (...args: unknown[]) => unknown>(),
  providers: new Map<string, unknown>(),
  /** withProgress 交给任务的取消标记 */
  progressToken: { isCancellationRequested: false },
  /** withProgress 的任务每次报告进度时调用（用来在处理途中触发取消） */
  onProgressReport: undefined as (() => void) | undefined,
  /** 工作区的根目录：设置后 findFiles / asRelativePath 在这个目录中工作 */
  workspaceRoot: undefined as string | undefined,
  reset(): void {
    this.onProgressReport = undefined;
    this.workspaceRoot = undefined;
    this.panels.length = 0;
    this.errors.length = 0;
    this.infos.length = 0;
    this.progressToken = { isCancellationRequested: false };
  },
};

export const window = {
  showErrorMessage: async (m: string) => void state.errors.push(m),
  showInformationMessage: async (m: string) => void state.infos.push(m),
  showWarningMessage: async () => undefined,
  showOpenDialog: async () => undefined,
  showSaveDialog: async () => undefined,
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showTextDocument: async () => undefined,
  withProgress: <T>(_opts: unknown, task: (p: { report: (v: unknown) => void }, token: unknown) => Thenable<T>) =>
    task({ report: () => state.onProgressReport?.() }, state.progressToken),
  createWebviewPanel: (_type: string, title: string) => {
    const p = new FakePanel();
    p.title = title;
    state.panels.push(p);
    return p;
  },
  registerCustomEditorProvider: (viewType: string, provider: unknown) => {
    state.providers.set(viewType, provider);
    return disposable();
  },
};

/** findFiles 用的简单 glob：**、*、?、{a,b} */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (glob.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 2;
    } else if (ch === '*') {
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      re += '(?:';
    } else if (ch === '}') {
      re += ')';
    } else if (ch === ',') {
      re += '|';
    } else {
      re += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function walk(dir: string): string[] {
  return nodeFs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const full = nodePath.join(dir, d.name);
    return d.isDirectory() ? walk(full) : [full];
  });
}

export const workspace = {
  workspaceFolders: undefined,
  getWorkspaceFolder: () => undefined,
  getConfiguration: () => ({ get: <T>(_key: string, dflt: T) => dflt }),
  findFiles: async (include: string, exclude?: string, max = Infinity) => {
    const root = state.workspaceRoot;
    if (!root) return [];
    const inc = globToRegExp(include);
    const exc = exclude ? globToRegExp(exclude) : undefined;
    return walk(root)
      .map((f) => nodePath.relative(root, f).split(nodePath.sep).join('/'))
      .filter((rel) => inc.test(rel) && !exc?.test(rel))
      .slice(0, max)
      .map((rel) => Uri.file(nodePath.join(root, rel)));
  },
  asRelativePath: (u: Uri) => (state.workspaceRoot ? nodePath.relative(state.workspaceRoot, u.fsPath).split(nodePath.sep).join('/') : u.fsPath),
  openTextDocument: async () => undefined,
  fs: {
    readFile: async (u: Uri) => new Uint8Array(await nodeFs.promises.readFile(u.fsPath)),
    writeFile: async () => {},
    stat: async (u: Uri) => {
      const st = await nodeFs.promises.stat(u.fsPath);
      return { type: st.isFile() ? FileType.File : FileType.Directory, size: st.size };
    },
    delete: async () => {},
    createDirectory: async () => {},
  },
};

export const commands = {
  registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
    state.commands.set(id, fn);
    return disposable();
  },
  executeCommand: async () => undefined,
};

/** 扩展上下文的替身 */
export function fakeContext(extensionRoot: string) {
  return {
    extensionUri: Uri.file(extensionRoot),
    subscriptions: [] as unknown[],
    globalState: { get: <T>(_k: string, d?: T) => d, update: async () => {} },
    extension: { packageJSON: { version: 'test' } },
  };
}
