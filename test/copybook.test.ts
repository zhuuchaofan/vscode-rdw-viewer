import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopybook, picInfo } from '../src/copybook';

test('自由格式：X / 9 / S9 / FILLER', () => {
  const cb = parseCopybook(`
    01 OUT-REC.
       05 OUT-F001-PD-0001   PIC X(9).
       05 OUT-COMMA-001      PIC X(1).
       05 OUT-F002           PIC S9(4).
       05 FILLER             PIC X(2).
  `);
  assert.deepEqual(
    cb.fields.map((f) => [f.name, f.offset, f.length, f.type]),
    [
      ['OUT-F001-PD-0001', 0, 9, 'alnum'],
      ['OUT-COMMA-001', 9, 1, 'alnum'],
      ['OUT-F002', 10, 4, 'num'],
      ['FILLER', 14, 2, 'alnum'],
    ]
  );
  assert.equal(cb.totalLength, 16);
});

test('固定格式：序号列、注释行、72 列后内容被忽略', () => {
  const lines = [
    '000100*  THIS IS A COMMENT                                                    ',
    '000200 01  REC.                                                               ',
    '000300     05  A     PIC X(3).                                                ',
    '000400     05  B     PIC 9(2).                                          SEQ001',
  ];
  const cb = parseCopybook(lines.join('\n'));
  assert.equal(cb.totalLength, 5);
  assert.deepEqual(cb.fields.map((f) => f.name), ['A', 'B']);
});

test('V、S 不占字节；重复写法 XXX / 999', () => {
  assert.equal(picInfo('S9(5)V99', 'DISPLAY', false).length, 7);
  assert.equal(picInfo('XXX', 'DISPLAY', false).length, 3);
  assert.equal(picInfo('999', 'DISPLAY', false).length, 3);
  assert.equal(picInfo('S9(3)', 'DISPLAY', true).length, 4);
});

test('COMP / COMP-3 长度', () => {
  assert.equal(picInfo('S9(4)', 'COMP', false).length, 2);
  assert.equal(picInfo('S9(9)', 'COMP', false).length, 4);
  assert.equal(picInfo('S9(10)', 'COMP', false).length, 8);
  assert.equal(picInfo('S9(7)', 'COMP-3', false).length, 4);
  assert.equal(picInfo('9(5)', 'COMP-3', false).length, 3);
});

test('OCCURS 展开，GROUP 内字段带下标', () => {
  const cb = parseCopybook(`
    01 R.
       05 A PIC X(2).
       05 G OCCURS 2 TIMES.
          10 B PIC 9(1).
          10 C PIC X(1).
  `);
  assert.deepEqual(cb.fields.map((f) => [f.name, f.offset]), [
    ['A', 0],
    ['B(1)', 2],
    ['C(1)', 3],
    ['B(2)', 4],
    ['C(2)', 5],
  ]);
  assert.equal(cb.totalLength, 6);
});

test('REDEFINES 被忽略并给出警告；88 级被跳过；VALUE 不影响解析', () => {
  const cb = parseCopybook(`
    01 R.
       05 A PIC X(4) VALUE 'AB. C'.
       05 A2 REDEFINES A PIC 9(4).
       05 FLAG PIC X.
          88 ON-FLAG VALUE 'Y'.
  `);
  assert.deepEqual(cb.fields.map((f) => f.name), ['A', 'FLAG']);
  assert.equal(cb.totalLength, 5);
  assert.ok(cb.warnings.some((w) => w.includes('REDEFINES')));
});
