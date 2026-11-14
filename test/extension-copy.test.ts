/**
 * 扩展端到端：打开 RDW 文件 → 按长度自动选中 copybook → 在工作区中找到并展开其中的 COPY。
 * 用 test/support/vscode-stub.ts 代替 VS Code，工作区为临时目录。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { rec, ascii } from './helpers';
import { loadExtension } from './support/load-extension';

const { vscode, ext } = loadExtension();
let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdw-copy-'));
  fs.mkdirSync(path.join(root, 'copybooks'));
  fs.mkdirSync(path.join(root, 'members'));
  // 主 copybook 与被引用的登録集原文在不同的目录；原文名大小写与文件名不同
  fs.writeFileSync(path.join(root, 'copybooks', 'MAIN.cpy'), '01 REC.\n   05 ID PIC X(4).\n   COPY detail REPLACING ==:L:== BY ==5==.\n   05 ST PIC X.\n');
  fs.writeFileSync(path.join(root, 'members', 'DETAIL.cpy'), '   05 D1 PIC X(:L:).\n');
  fs.writeFileSync(path.join(root, 'data.dat'), Buffer.concat([rec(ascii('0001ABCDE1')), rec(ascii('0002FGHIJ2'))]));
  ext.activate(vscode.fakeContext(path.resolve(__dirname, '../..')));
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('自动选中的 copybook 中的 COPY 被展开，REPLACING 生效，提示条说明展开了哪个文件', async () => {
  vscode.state.reset();
  vscode.state.workspaceRoot = root;
  const provider = vscode.state.providers.get(ext.EDITOR_VIEW_TYPE) as {
    openCustomDocument(u: unknown, c: unknown, t: unknown): Promise<{ dispose(): void }>;
    resolveCustomEditor(d: unknown, p: unknown, t: unknown): Promise<void>;
  };
  const doc = await provider.openCustomDocument(vscode.Uri.file(path.join(root, 'data.dat')), {}, { isCancellationRequested: false });
  const panel = new vscode.FakePanel();
  await provider.resolveCustomEditor(doc, panel, {});
  await panel.receive({ type: 'ready' });
  const init = panel.posted.find((m) => m.type === 'init') as unknown as {
    groups: Array<{ copybookName: string; banner: { level: string; text: string }; columns: Array<{ name: string; start: number; len: number }> }>;
  };
  const g = init.groups[0];
  assert.equal(g.copybookName, 'MAIN.cpy');
  assert.deepEqual(g.columns.map((c) => [c.name, c.start, c.len]), [['ID', 1, 4], ['D1', 5, 5], ['ST', 10, 1]]);
  assert.equal(g.banner.level, 'info');
  assert.match(g.banner.text, /members\/DETAIL\.cpy/);
  doc.dispose();
});
