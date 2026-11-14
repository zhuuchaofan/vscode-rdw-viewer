/**
 * 在真实的 VS Code 中运行的测试（由 runTest.ts 启动）。
 * 只确认扩展与 VS Code 的结合部分：激活、自定义编辑器的打开 / 关闭 / 重新打开、比较面板。
 * 表格内容由 test/ 下的单元测试覆盖（webview 的内容无法从扩展测试中读取）。
 */
import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';

const EXT_ID = 'zhuuchaofan.rdw-viewer';
const VIEW_TYPE = 'rdwViewer.editor';

function examples(name: string): vscode.Uri {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, '工作区应为 examples/');
  return vscode.Uri.file(path.join(folder.uri.fsPath, name));
}

async function waitFor<T>(what: string, check: () => T | undefined, timeoutMs = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`超时：${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const allTabs = () => vscode.window.tabGroups.all.flatMap((g) => g.tabs);
const customTabs = () => allTabs().filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE);
const webviewTabs = () => allTabs().filter((t) => t.input instanceof vscode.TabInputWebview);

async function closeAll(): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await waitFor('关闭全部编辑器', () => (allTabs().length === 0 ? true : undefined));
}

const cases: Array<[string, () => Promise<void>]> = [
  [
    '扩展激活后注册命令',
    async () => {
      const ext = vscode.extensions.getExtension(EXT_ID);
      assert.ok(ext, `找不到扩展 ${EXT_ID}`);
      await ext.activate();
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('rdwViewer.open'));
      assert.ok(commands.includes('rdwViewer.compare'));
    },
  ],
  [
    '用「打开方式」以自定义编辑器打开 RDW 文件，关闭后可以再次打开',
    async () => {
      const uri = examples('01-customer.dat');
      for (let i = 0; i < 2; i++) {
        await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
        const tab = await waitFor('自定义编辑器标签页', () => customTabs()[0]);
        assert.equal((tab.input as vscode.TabInputCustom).uri.fsPath, uri.fsPath);
        await closeAll();
      }
    },
  ],
  [
    'rdwViewer.open 命令打开自定义编辑器；含 RDW 错误的文件也能打开',
    async () => {
      for (const name of ['02-mixed-length.dat', '06-broken.dat', '07-no-copybook.dat']) {
        await vscode.commands.executeCommand('rdwViewer.open', examples(name));
        const tab = await waitFor(`${name} 的标签页`, () => customTabs().find((t) => (t.input as vscode.TabInputCustom).uri.fsPath.endsWith(name)));
        assert.ok(tab);
      }
      assert.equal(customTabs().length, 3);
      await closeAll();
    },
  ],
  [
    '同一文件不会同时打开两个编辑器（supportsMultipleEditorsPerDocument: false）',
    async () => {
      const uri = examples('03-same-length.dat');
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.One);
      await waitFor('第一个标签页', () => customTabs()[0]);
      await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.Two);
      await new Promise((r) => setTimeout(r, 1000));
      assert.equal(customTabs().length, 1);
      await closeAll();
    },
  ],
  [
    'rdwViewer.compare 打开比较面板，关闭后可以再次比较',
    async () => {
      const a = examples('01-customer.dat');
      const b = examples('05-numeric.dat');
      for (let i = 0; i < 2; i++) {
        await vscode.commands.executeCommand('rdwViewer.compare', a, [a, b]);
        const tab = await waitFor('比较面板', () => webviewTabs()[0]);
        assert.match(tab.label, /01-customer\.dat.*05-numeric\.dat/);
        await closeAll();
      }
    },
  ],
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  for (const [name, fn] of cases) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (e) {
      console.log(`  ✗ ${name}\n    ${(e as Error).stack ?? e}`);
      failures.push(name);
      await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    }
  }
  console.log(`\n${cases.length - failures.length} passing, ${failures.length} failing`);
  if (failures.length > 0) {
    throw new Error(`${failures.length} 个集成测试失败`);
  }
}
