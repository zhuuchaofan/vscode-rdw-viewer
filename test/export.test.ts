import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RdwSession } from '../src/session';
import { parseCopybook } from '../src/copybook';
import { exportChunks, escapeField, viewFileSuffix, ExportOptions } from '../src/export';
import { rec, ascii, hexBytes } from './helpers';

const all = (s: RdwSession, view: string, o: ExportOptions, batch?: number) =>
  [...exportChunks(s, view, o, batch)].map((c) => c.text).join('');

const CSV: ExportOptions = { format: 'csv', header: true, meta: true, position: true };

test('CSV / TSV 转义', () => {
  assert.equal(escapeField('A,B', 'csv'), '"A,B"');
  assert.equal(escapeField('say "hi"', 'csv'), '"say ""hi"""');
  assert.equal(escapeField('  ABC ', 'csv'), '  ABC ');
  assert.equal(escapeField('A\tB\r\nC', 'tsv'), 'A B  C');
});

function sample() {
  const cb = parseCopybook(`
    01 R.
       05 ID    PIC S9(5) COMP-3.
       05 NAME  PIC X(6).
       05 AMT   PIC S9(5)V99 COMP-3.
  `); // 3 + 6 + 4 = 13
  const r = (id: string, name: string, amt: string) => rec(Buffer.concat([hexBytes(id), ascii(name), hexBytes(amt)]));
  const file = Buffer.concat([
    r('10 10 0C', 'AB,CD ', '00 12 34 5C'),
    rec(ascii('BAD'), { back: 9 }),
    r('10 20 0D', 'XY"Z  ', '00 00 05 0D'),
    rec(Buffer.concat([hexBytes('10 99 9C'), ascii('TRAILER')])), // 10 字节，无 copybook
  ]);
  const s = new RdwSession(file, 't.dat');
  s.setCopybook(13, { name: 'r.cpy', copybook: cb });
  return s;
}

test('分组导出：三行表头、序号和偏移、COMP-3 解码、CSV 转义', () => {
  const s = sample();
  assert.equal(
    all(s, 'L13', CSV),
    [
      '#,偏移,ID,NAME,AMT',
      '属性,,S9(5) COMP-3,X(6),S9(5)V99 COMP-3',
      '相対位置,,1,4,10',
      '1,0x00000000,+10100,"AB,CD ",+123.45',
      '3,0x00000020,-10200,"XY""Z  ",-0.50',
      '',
    ].join('\r\n')
  );
});

test('选项：不要表头 / 属性行 / 序号列，TSV', () => {
  const s = sample();
  assert.equal(all(s, 'L13', { format: 'tsv', header: false, meta: false, position: false }), '+10100\tAB,CD \t+123.45\r\n-10200\tXY"Z  \t-0.50\r\n');
});

test('无 copybook 分组：自动识别的 COMP-3 导出为 [值]', () => {
  const s = sample();
  const text = all(s, 'L10', { format: 'csv', header: true, meta: false, position: false });
  assert.equal(text, '(正文)\r\n[+10999]TRAILER\r\n');
});

test('错误列表导出', () => {
  const s = sample();
  const lines = all(s, 'ERR', CSV).split('\r\n');
  assert.equal(lines[0], '#,偏移,跳过字节,原因');
  assert.match(lines[1], /^2,0x00000015,11,.*前后不一致/);
});

test('分批生成：批次边界不丢行，进度递增', () => {
  const s = sample();
  const chunks = [...exportChunks(s, 'L13', CSV, 1)];
  assert.deepEqual(chunks.map((c) => c.done), [0, 1, 2]);
  assert.equal(chunks.map((c) => c.text).join(''), all(s, 'L13', CSV));
});

test('导出文件名后缀', () => {
  const s = sample();
  assert.equal(viewFileSuffix(s, 'L13'), '13');
  assert.equal(viewFileSuffix(s, 'ERR'), 'errors');
  s.setDiscriminator(13, { start: 4, length: 2, type: 'text' });
  assert.deepEqual(s.groups.filter((g) => g.length === 13).map((g) => viewFileSuffix(s, g.key)), ['13_AB', '13_XY']);
});

test('控制字符图形在导出时还原为 ·（Shift_JIS 中为 ・），与之前的导出结果一致', async () => {
  const { exportText } = await import('../src/export');
  assert.equal(exportText('A␀B␡'), 'A·B·');
});
