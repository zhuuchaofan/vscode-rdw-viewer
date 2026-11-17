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
  await (doc as unknown as { loading: Promise<unknown> }).loading;
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

test('工作区 copybook 一览被缓存：再次打开不再重新查找 COPY 原文；原文改变后重新解析', async () => {
  vscode.state.reset();
  vscode.state.workspaceRoot = root;
  const provider = vscode.state.providers.get(ext.EDITOR_VIEW_TYPE) as {
    openCustomDocument(u: unknown, c: unknown, t: unknown): Promise<{ dispose(): void }>;
    resolveCustomEditor(d: unknown, p: unknown, t: unknown): Promise<void>;
  };
  // 统计为 COPY 查找原文的次数（copybook 一览本身的查找除外）
  const origFind = vscode.workspace.findFiles;
  let memberLookups = 0;
  vscode.workspace.findFiles = async (include: string, ...rest: [string?, number?]) => {
    if (!include.includes('cpy,CPY')) memberLookups++;
    return origFind(include, ...rest);
  };
  const open = async () => {
    memberLookups = 0;
    const doc = await provider.openCustomDocument(vscode.Uri.file(path.join(root, 'data.dat')), {}, { isCancellationRequested: false });
  await (doc as unknown as { loading: Promise<unknown> }).loading;
    const panel = new vscode.FakePanel();
    await provider.resolveCustomEditor(doc, panel, {});
    await panel.receive({ type: 'ready' });
    const init = panel.posted.find((m) => m.type === 'init') as unknown as { groups: Array<{ copybookName: string | null }> };
    doc.dispose();
    return { name: init.groups[0].copybookName, lookups: memberLookups };
  };
  try {
    // 上一个用例已经打开过一次：一览使用缓存，只有为显示而读取 MAIN.cpy 时查找一次原文（不缓存时为 2 次）
    for (let i = 0; i < 2; i++) {
      const again = await open();
      assert.equal(again.name, 'MAIN.cpy');
      assert.equal(again.lookups, 1);
    }

    // 原文变长：MAIN.cpy 的总长度不再是 10，不能沿用缓存中的长度自动选中
    const member = path.join(root, 'members', 'DETAIL.cpy');
    const orig = fs.readFileSync(member, 'utf8');
    fs.writeFileSync(member, '   05 D1 PIC X(:L:).\n   05 D2 PIC X(3).\n');
    try {
      const third = await open();
      assert.equal(third.name, null);
    } finally {
      fs.writeFileSync(member, orig);
    }
  } finally {
    vscode.workspace.findFiles = origFind;
  }
});

test('「选择 copybook」：选择框不等扫描完成就打开，列表扫描完成后填入', async () => {
  vscode.state.reset();
  vscode.state.workspaceRoot = root;
  const provider = vscode.state.providers.get(ext.EDITOR_VIEW_TYPE) as {
    openCustomDocument(u: unknown, c: unknown, t: unknown): Promise<{ dispose(): void; loading: Promise<unknown> }>;
    resolveCustomEditor(d: unknown, p: unknown, t: unknown): Promise<void>;
  };
  const doc = await provider.openCustomDocument(vscode.Uri.file(path.join(root, 'data.dat')), {}, { isCancellationRequested: false });
  await doc.loading;
  const panel = new vscode.FakePanel();
  await provider.resolveCustomEditor(doc, panel, {});
  await panel.receive({ type: 'ready' });
  const init = panel.posted.find((m) => m.type === 'init') as unknown as { groups: Array<{ key: string }> };

  const origPick = vscode.window.showQuickPick;
  let itemsWasPending = false;
  let labels: string[] = [];
  (vscode.window as { showQuickPick: unknown }).showQuickPick = async (items: unknown) => {
    itemsWasPending = items instanceof Promise;
    labels = ((await items) as Array<{ label: string }>).map((x) => x.label);
    return undefined;
  };
  try {
    await panel.receive({ type: 'chooseCopybook', g: init.groups[0].key });
  } finally {
    (vscode.window as { showQuickPick: unknown }).showQuickPick = origPick;
  }
  assert.ok(itemsWasPending, '应把尚未完成的列表交给 showQuickPick');
  assert.ok(labels.some((l) => l.includes('MAIN.cpy')));
  doc.dispose();
});
