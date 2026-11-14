/**
 * 扩展端到端：比较面板中选择忽略的字段、导出差异报告。
 * 用 test/support/vscode-stub.ts 代替 VS Code，模拟用户在快速选择和保存对话框中的操作。
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'rdw-cmp-'));
  fs.writeFileSync(path.join(root, 'REC.cpy'), '01 REC. 05 ID PIC X(3). 05 NAME PIC X(4). 05 AMT PIC 9(3).');
  fs.writeFileSync(path.join(root, 'a.dat'), Buffer.concat(['001AAAA100', '002BBBB200'].map((r) => rec(ascii(r)))));
  fs.writeFileSync(path.join(root, 'b.dat'), Buffer.concat(['001AAAA101', '002XXXX200'].map((r) => rec(ascii(r)))));
  ext.activate(vscode.fakeContext(path.resolve(__dirname, '../..')));
});

after(() => fs.rmSync(root, { recursive: true, force: true }));

test('选择忽略的字段 → 重新比较；导出差异报告（Shift_JIS）', async () => {
  vscode.state.reset();
  vscode.state.workspaceRoot = root;
  const compare = vscode.state.commands.get('rdwViewer.compare') as (u?: unknown, us?: unknown[]) => Promise<void>;
  await compare(undefined, [vscode.Uri.file(path.join(root, 'a.dat')), vscode.Uri.file(path.join(root, 'b.dat'))]);
  const panel = vscode.state.panels[0];
  const lastInit = () => [...panel.posted].reverse().find((m) => m.type === 'cinit') as unknown as { ignore: string[]; stats: { same: number; chg: number } };
  await panel.receive({ type: 'ready' });
  assert.deepEqual(lastInit().stats, { pairs: 2, same: 0, chg: 2, a: 0, b: 0, noKeyA: 0, noKeyB: 0 });

  // 快速选择中列出的是字段名；选 AMT
  let offered: string[] = [];
  vscode.state.answers.quickPick = (items, opts) => {
    offered = items.map((x) => x.label);
    assert.equal(opts.canPickMany, true);
    return items.filter((x) => x.label === 'AMT');
  };
  await panel.receive({ type: 'chooseIgnore' });
  assert.deepEqual(offered, ['ID', 'NAME', 'AMT']);
  assert.deepEqual(lastInit().ignore, ['AMT']);
  assert.equal(lastInit().stats.same, 1);

  // 交换 A / B 后仍然忽略 AMT
  await panel.receive({ type: 'swap' });
  assert.deepEqual(lastInit().ignore, ['AMT']);
  await panel.receive({ type: 'swap' });

  const out = path.join(root, 'diff.csv');
  vscode.state.answers.quickPick = (items) => items.find((x) => x.label === 'CSV');
  vscode.state.answers.saveDialog = () => vscode.Uri.file(out);
  await panel.receive({ type: 'exportDiff' });
  const text = new TextDecoder('shift_jis').decode(fs.readFileSync(out));
  const lines = text.trimEnd().split('\r\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^対応番号,状態,/);
  assert.equal(lines[1], '2,相違,2,2,NAME,4,BBBB,XXXX');
  panel.dispose();
});
