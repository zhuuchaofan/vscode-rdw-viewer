import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopybook, layoutRecord, picInfo } from '../src/copybook';

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

test('REDEFINES 默认显示原项目、不重复占位；88 级被跳过；VALUE 不影响解析', () => {
  const cb = parseCopybook(`
    01 R.
       05 A PIC X(4) VALUE 'AB. C'.
       05 A2 REDEFINES A PIC 9(4).
       05 FLAG PIC X.
          88 ON-FLAG VALUE 'Y'.
  `);
  assert.deepEqual(cb.fields.map((f) => f.name), ['A', 'FLAG']);
  assert.equal(cb.totalLength, 5);
  assert.deepEqual(cb.warnings, []);
  assert.deepEqual(cb.records[0].sets.map((x) => x.options), [['A', 'A2']]);
})

test('V 之后的位数记为小数位数；字段带 USAGE', () => {
  assert.equal(picInfo('S9(5)V99', 'COMP-3', false).scale, 2);
  assert.equal(picInfo('9(3)', 'COMP-3', false).scale, 0);
  const cb = parseCopybook('01 R. 05 A PIC S9(5)V99 COMP-3. 05 B PIC X(2).');
  assert.deepEqual(cb.fields.map((f) => [f.name, f.usage, f.scale, f.length]), [
    ['A', 'COMP-3', 2, 4],
    ['B', 'DISPLAY', 0, 2],
  ]);
});

test('固定格式：有一行不规整时，其余带序号的行和 73~80 列标识仍被正确处理', () => {
  const pad = (s: string) => s.padEnd(72, ' ');
  const lines = [
    pad('000100*    サンプルファイル') + 'SAMPLE01',
    pad('000200 01  SMPL-REC.') + 'SAMPLE01',
    pad('000300     05  KEY-ID      PIC X(10).') + 'SAMPLE01',
    '\t05  ODD-LINE   PIC X(5).', // Tab 缩进，不符合固定格式
    pad('000500     05  AMT         PIC S9(7) COMP-3.') + 'SAMPLE01',
    pad('000600     05  FILLER      PIC X(3).') + 'SAMPLE01',
  ];
  const cb = parseCopybook(lines.join('\r\n'));
  assert.deepEqual(cb.fields.map((f) => [f.name, f.offset, f.length]), [
    ['KEY-ID', 0, 10],
    ['ODD-LINE', 10, 5],
    ['AMT', 15, 4],
    ['FILLER', 19, 3],
  ]);
  assert.equal(cb.totalLength, 22);
  assert.deepEqual(cb.warnings, []);
});

test('PIC N / G 每字符 2 字节', () => {
  assert.equal(picInfo('N(10)', 'DISPLAY', false).length, 20);
  assert.equal(picInfo('NNN', 'NATIONAL', false).length, 6);
  assert.equal(picInfo('G(3)', 'DISPLAY-1', false).length, 6);
  const cb = parseCopybook('01 R. 05 名前 PIC N(5). 05 B PIC X(2) USAGE DISPLAY.');
  assert.equal(cb.totalLength, 12);
});

test('COMPUTATIONAL-3 等全称写法', () => {
  const cb = parseCopybook(`
    01 R.
       05 A PIC S9(5) COMPUTATIONAL-3.
       05 B PIC S9(4) USAGE IS COMPUTATIONAL.
  `);
  assert.deepEqual(cb.fields.map((f) => [f.usage, f.length]), [
    ['COMP-3', 3],
    ['COMP', 2],
  ]);
});

test('多个 01：保留全部，并可按记录长度选用', async () => {
  const { selectRecord } = await import('../src/copybook');
  const cb = parseCopybook(`
    01 HDR-REC.
       05 H1 PIC X(10).
    01 DATA-REC.
       05 D1 PIC X(20).
  `);
  assert.deepEqual(cb.records.map((r) => [r.name, r.totalLength]), [
    ['HDR-REC', 10],
    ['DATA-REC', 20],
  ]);
  assert.equal(selectRecord(cb, 20)!.name, 'DATA-REC');
  assert.equal(selectRecord(cb, 99)!.name, 'HDR-REC');
});

test('语句开头有无法识别的内容：跳过并提示，字段不丢失', () => {
  const cb = parseCopybook('01 R. 05 A PIC X(2). GARBAGE 05 B PIC X(3).');
  assert.deepEqual(cb.fields.map((f) => f.name), ['A', 'B']);
  assert.ok(cb.warnings.some((w) => w.includes('GARBAGE')));
});

test('无 01 层：顶层多个并列 05 合并为同一条记录，偏移连续', () => {
  const cb = parseCopybook(`
    05 A PIC X(3).
    05 B PIC 9(4).
    05 C PIC X(2).
  `);
  assert.equal(cb.records.length, 1);
  assert.equal(cb.records[0].name, 'A');
  assert.equal(cb.totalLength, 9);
  assert.deepEqual(
    cb.fields.map((f) => [f.name, f.offset, f.length]),
    [
      ['A', 0, 3],
      ['B', 3, 4],
      ['C', 7, 2],
    ]
  );
  assert.deepEqual(cb.warnings, []);
});

test('无 01 层：顶层多个并列 10 合并为同一条记录', () => {
  const cb = parseCopybook(`
    10 X1 PIC X(4).
    10 X2 PIC 9(3).
    10 X3 PIC X(5).
  `);
  assert.equal(cb.records.length, 1);
  assert.equal(cb.records[0].name, 'X1');
  assert.equal(cb.totalLength, 12);
  assert.deepEqual(
    cb.fields.map((f) => [f.name, f.offset, f.length]),
    [
      ['X1', 0, 4],
      ['X2', 4, 3],
      ['X3', 7, 5],
    ]
  );
});

test('无 01 层：先 10 后 05 仍归入同一虚拟 01 记录', () => {
  const cb = parseCopybook(`
    10 FIRST-F PIC X(2).
    05 SECOND-G.
       10 SUB-A PIC X(3).
       10 SUB-B PIC 9(4).
  `);
  assert.equal(cb.records.length, 1);
  assert.equal(cb.records[0].name, 'FIRST-F');
  assert.equal(cb.totalLength, 9);
  assert.deepEqual(
    cb.fields.map((f) => [f.name, f.offset, f.length]),
    [
      ['FIRST-F', 0, 2],
      ['SUB-A', 2, 3],
      ['SUB-B', 5, 4],
    ]
  );
});

test('无 01 层：REDEFINES 正常分组且 id 无前导点', () => {
  const cb = parseCopybook(`
    05 HEAD PIC X(2).
    05 BODY-A PIC X(4).
    05 BODY-B REDEFINES BODY-A.
       10 B1 PIC 9(2).
       10 B2 PIC X(2).
    05 TAIL PIC X(1).
  `);
  assert.equal(cb.records.length, 1);
  assert.equal(cb.totalLength, 7);
  const rec = cb.records[0];
  assert.equal(rec.sets.length, 1);
  assert.ok(!rec.sets[0].id.startsWith('.'));
  assert.deepEqual(rec.sets[0].options, ['BODY-A', 'BODY-B']);
  assert.deepEqual(
    cb.fields.map((f) => [f.name, f.offset, f.length]),
    [
      ['HEAD', 0, 2],
      ['BODY-A', 2, 4],
      ['TAIL', 6, 1],
    ]
  );
  const alt = layoutRecord(rec, { [rec.sets[0].id]: 'BODY-B' });
  assert.deepEqual(
    alt.fields.map((f) => [f.name, f.offset, f.length]),
    [
      ['HEAD', 0, 2],
      ['B1', 2, 2],
      ['B2', 4, 2],
      ['TAIL', 6, 1],
    ]
  );
  assert.equal(alt.totalLength, 7);
});

test('无 01 层：OCCURS 正常展开并与后续同级项偏移连续', () => {
  const cb = parseCopybook(`
    05 ITEM OCCURS 3 TIMES.
       10 CODE PIC X(2).
       10 QTY PIC 9(1).
    05 TOTAL PIC 9(4).
  `);
  assert.equal(cb.records.length, 1);
  assert.equal(cb.totalLength, 13);
  assert.deepEqual(
    cb.fields.map((f) => [f.name, f.offset, f.length]),
    [
      ['CODE(1)', 0, 2],
      ['QTY(1)', 2, 1],
      ['CODE(2)', 3, 2],
      ['QTY(2)', 5, 1],
      ['CODE(3)', 6, 2],
      ['QTY(3)', 8, 1],
      ['TOTAL', 9, 4],
    ]
  );
});

test('无 01 层：中途未展开 COPY 仅标后续字段为可疑', () => {
  const cb = parseCopybook(`
    05 BEFORE-F PIC X(3).
    COPY MISSING-MEM.
    05 AFTER-F PIC X(4).
  `);
  assert.equal(cb.records.length, 1);
  assert.equal(cb.totalLength, 7);
  assert.equal(cb.records[0].trust, 'untrusted');
  assert.deepEqual(
    cb.fields.map((f) => [f.name, f.offset, f.length, !!f.suspect]),
    [
      ['BEFORE-F', 0, 3, false],
      ['AFTER-F', 3, 4, true],
    ]
  );
  assert.ok(cb.warnings.some((w) => w.includes('MISSING-MEM')));
});

test('回归保护：多个 77 与多个 01 仍各自作为独立记录', () => {
  const cb77 = parseCopybook(`
    77 WS-A PIC X(3).
    77 WS-B PIC 9(5).
  `);
  assert.deepEqual(
    cb77.records.map((r) => [r.name, r.totalLength]),
    [
      ['WS-A', 3],
      ['WS-B', 5],
    ]
  );

  const cb01 = parseCopybook(`
    01 REC-1.
       05 F1 PIC X(4).
       05 F1-ALT REDEFINES F1 PIC 9(4).
    01 REC-2.
       05 F2 PIC X(6).
  `);
  assert.deepEqual(
    cb01.records.map((r) => [r.name, r.totalLength]),
    [
      ['REC-1', 4],
      ['REC-2', 6],
    ]
  );
  assert.equal(cb01.records[0].sets[0].id, 'REC-1.F1');
});

test('01 なしで 05 が 1 つだけ：REDEFINES の id とレコード名は従来どおり', () => {
  const cb = parseCopybook(`
    05 A.
       10 X PIC X(3).
       10 Y REDEFINES X PIC 9(3).
  `);
  assert.equal(cb.records.length, 1);
  assert.equal(cb.records[0].name, 'A');
  assert.equal(cb.records[0].totalLength, 3);
  assert.equal(cb.records[0].sets[0].id, 'A.X');
});
