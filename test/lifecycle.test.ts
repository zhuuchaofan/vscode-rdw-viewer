/**
 * 自定义编辑器与比较面板的生命周期：打开 → 显示 → 关闭 / 取消 / 失败 之后，
 * 分页读取用的文件描述符必须全部释放（Windows 上未释放会一直锁住文件）。
 *
 * 用 test/support/vscode-stub.ts 代替 `vscode` 模块，直接运行 src/extension.ts 的真实代码；
 * 不验证界面，也不代替在 VS Code 里的实际操作确认。
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PagedFileSource } from '../src/source';
import { rec, ascii } from './helpers';
import type * as Stub from './support/vscode-stub';

import { loadExtension } from './support/load-extension';

const { vscode, ext } = loadExtension();

interface Provider {
  openCustomDocument(uri: Stub.Uri, ctx: unknown, token: { isCancellationRequested: boolean }): Promise<{ dispose(): void }>;
  resolveCustomEditor(doc: unknown, panel: Stub.FakePanel, token: unknown): Promise<void>;
}

const NEVER = { isCancellationRequested: false };
const DEFAULTS = { ...ext.thresholds };
let dir = '';
let fileA = '';
let fileB = '';
let damaged = '';
let provider: Provider;
let compare: (uri?: Stub.Uri, uris?: Stub.Uri[]) => Promise<void>;

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdw-lifecycle-'));
  const records = (n: number, mark: string) =>
    Buffer.concat(Array.from({ length: n }, (_, i) => rec(ascii(String(i).padStart(6, '0') + mark.repeat(94)))));
  fileA = path.join(dir, 'a.dat');
  fileB = path.join(dir, 'b.dat');
  fs.writeFileSync(fileA, records(300, 'A'));
  fs.writeFileSync(fileB, records(300, 'B'));
  // 损坏的文件：大段无法对齐的数据之间夹着正常记录，扫描要逐字节重新对齐，耗时足够长
  let seed = 7;
  const garbage = (n: number) => {
    const b = Buffer.alloc(n);
    for (let i = 0; i < n; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      b[i] = seed >>> 24;
    }
    return b;
  };
  damaged = path.join(dir, 'damaged.dat');
  fs.writeFileSync(damaged, Buffer.concat(Array.from({ length: 24 }, () => Buffer.concat([garbage(900 * 1024), records(2, 'C')]))));

  ext.activate(vscode.fakeContext(path.resolve(__dirname, '../..')));
  provider = vscode.state.providers.get(ext.EDITOR_VIEW_TYPE) as Provider;
  compare = vscode.state.commands.get('rdwViewer.compare') as typeof compare;
});

after(() => {
  Object.assign(ext.thresholds, DEFAULTS);
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  vscode.state.reset();
  // 让几十 KB 的测试文件也走分页读取；异步扫描 / 异步比较按用例单独打开
  Object.assign(ext.thresholds, DEFAULTS, { pagedFile: 1024 });
  assert.equal(PagedFileSource.openCount, 0, '上一个用例留下了未关闭的文件');
});

test('自定义编辑器：打开 → 显示 → 关闭面板 → 释放文档，文件描述符被关闭', async () => {
  const doc = await provider.openCustomDocument(vscode.Uri.file(fileA), {}, NEVER);
  assert.equal(PagedFileSource.openCount, 1);

  const panel = new vscode.FakePanel();
  await provider.resolveCustomEditor(doc, panel, NEVER);
  await panel.receive({ type: 'ready' });
  assert.equal(panel.posted[0]?.type, 'init');

  // VS Code 的顺序：先关闭面板，最后一个编辑器关闭后释放文档
  panel.dispose();
  assert.equal(PagedFileSource.openCount, 1, '文档还在，文件应保持打开');
  doc.dispose();
  assert.equal(PagedFileSource.openCount, 0);
  doc.dispose(); // 重复释放不报错
  assert.equal(PagedFileSource.openCount, 0);
});

test('自定义编辑器：打开前已取消 → 不留下文件描述符', async () => {
  ext.thresholds.scanProgress = 1024;
  await assert.rejects(provider.openCustomDocument(vscode.Uri.file(fileA), {}, { isCancellationRequested: true }));
  assert.equal(PagedFileSource.openCount, 0);
  assert.deepEqual(vscode.state.infos, [], '由 VS Code 取消（关闭编辑器）时不提示');
});

test('自定义编辑器：扫描损坏的大文件途中取消 → 很快结束，文件描述符被关闭', async () => {
  ext.thresholds.scanProgress = 1024;
  const token = { isCancellationRequested: false };
  const started = performance.now();
  // 扫描开始之后、第一次报告进度时取消（相当于用户在打开途中关闭了标签页）
  let reports = 0;
  vscode.state.onProgressReport = () => {
    reports++;
    token.isCancellationRequested = true;
  };
  await assert.rejects(provider.openCustomDocument(vscode.Uri.file(damaged), {}, token));
  const cancelledAfter = performance.now() - started;
  assert.equal(reports, 1, '取消后不应继续扫描');
  assert.equal(PagedFileSource.openCount, 0);
  vscode.state.onProgressReport = undefined;

  // 对照：不取消时完整扫描所需的时间；取消应明显更早结束
  const t0 = performance.now();
  const doc = await provider.openCustomDocument(vscode.Uri.file(damaged), {}, NEVER);
  const full = performance.now() - t0;
  doc.dispose();
  assert.equal(PagedFileSource.openCount, 0);
  assert.ok(cancelledAfter < full / 2, `取消用了 ${cancelledAfter.toFixed(0)}ms，完整扫描 ${full.toFixed(0)}ms`);
});

test('自定义编辑器：通知上的「取消」→ 提示已取消，文件描述符被关闭', async () => {
  ext.thresholds.scanProgress = 1024;
  vscode.state.progressToken.isCancellationRequested = true;
  await assert.rejects(provider.openCustomDocument(vscode.Uri.file(fileA), {}, NEVER));
  assert.equal(PagedFileSource.openCount, 0);
  assert.equal(vscode.state.infos.length, 1);
});

test('比较：B 文件不存在 → 报错，已打开的 A 被关闭', async () => {
  await compare(undefined, [vscode.Uri.file(fileA), vscode.Uri.file(path.join(dir, 'missing.dat'))]);
  assert.equal(vscode.state.errors.length, 1);
  assert.equal(vscode.state.panels.length, 0);
  assert.equal(PagedFileSource.openCount, 0);
});

test('比较：A 文件不存在 → 报错，不打开 B', async () => {
  await compare(undefined, [vscode.Uri.file(path.join(dir, 'missing.dat')), vscode.Uri.file(fileB)]);
  assert.equal(vscode.state.errors.length, 1);
  assert.equal(PagedFileSource.openCount, 0);
});

test('比较：取消比较 → 不建立面板，A / B 都被关闭', async () => {
  ext.thresholds.compareProgress = 0;
  vscode.state.progressToken.isCancellationRequested = true;
  await compare(undefined, [vscode.Uri.file(fileA), vscode.Uri.file(fileB)]);
  assert.equal(vscode.state.panels.length, 0);
  assert.equal(vscode.state.infos.length, 1);
  assert.equal(PagedFileSource.openCount, 0);
});

test('比较：正常打开 → 交换 A / B → 关闭面板，A / B 都被关闭', async () => {
  await compare(undefined, [vscode.Uri.file(fileA), vscode.Uri.file(fileB)]);
  assert.equal(vscode.state.panels.length, 1);
  assert.equal(PagedFileSource.openCount, 2);
  const panel = vscode.state.panels[0];
  await panel.receive({ type: 'ready' });
  assert.equal(panel.posted[0]?.type, 'cinit');

  // 交换只是调换同一对会话，不会再打开文件
  await panel.receive({ type: 'swap' });
  assert.equal(PagedFileSource.openCount, 2);
  assert.equal(panel.title, 'RDW: b.dat ⇄ a.dat');

  panel.dispose();
  assert.equal(PagedFileSource.openCount, 0);
});
