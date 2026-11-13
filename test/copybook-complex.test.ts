/**
 * P0：复杂 COPY 句布局。预期的偏移、长度都按 COBOL 规则手工计算，而不是从代码输出抄来。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopybook, layoutRecord, picInfo } from '../src/copybook';

/** [名称, 偏移(从 0 开始), 长度] */
const layout = (fields: { name: string; offset: number; length: number }[]) => fields.map((f) => [f.name, f.offset, f.length]);

test('实际业务风格的记录：组项目、组级 USAGE、OCCURS、COMP-2、PIC N，总长 100', () => {
  const cb = parseCopybook(`
       01  ORDER-REC.
           05  ORD-KEY.
               10  ORD-TYPE        PIC X(2).
               10  ORD-NO          PIC 9(8).
           05  ORD-DATE            PIC 9(8).
           05  ORD-AMOUNTS         USAGE COMP-3.
               10  ORD-TOTAL       PIC S9(9)V99.
               10  ORD-TAX         PIC S9(7)V99.
           05  ORD-COUNT           PIC S9(4) COMP.
           05  ORD-LINES OCCURS 3 TIMES.
               10  LN-ITEM         PIC X(6).
               10  LN-QTY          PIC S9(5) COMP-3.
               10  LN-PRICE        PIC S9(7)V99 COMP-3.
           05  ORD-FLAG            PIC X OCCURS 4.
           05  ORD-RATE            COMP-2.
           05  ORD-NOTE            PIC N(5).
           05  FILLER              PIC X(5).
  `);
  assert.deepEqual(layout(cb.fields), [
    ['ORD-TYPE', 0, 2],
    ['ORD-NO', 2, 8],
    ['ORD-DATE', 10, 8],
    ['ORD-TOTAL', 18, 6], // S9(9)V99：11 位 → 6 字节
    ['ORD-TAX', 24, 5], // S9(7)V99：9 位 → 5 字节
    ['ORD-COUNT', 29, 2],
    ['LN-ITEM(1)', 31, 6],
    ['LN-QTY(1)', 37, 3],
    ['LN-PRICE(1)', 40, 5],
    ['LN-ITEM(2)', 45, 6],
    ['LN-QTY(2)', 51, 3],
    ['LN-PRICE(2)', 54, 5],
    ['LN-ITEM(3)', 59, 6],
    ['LN-QTY(3)', 65, 3],
    ['LN-PRICE(3)', 68, 5],
    ['ORD-FLAG(1)', 73, 1],
    ['ORD-FLAG(2)', 74, 1],
    ['ORD-FLAG(3)', 75, 1],
    ['ORD-FLAG(4)', 76, 1],
    ['ORD-RATE', 77, 8],
    ['ORD-NOTE', 85, 10],
    ['FILLER', 95, 5],
  ]);
  assert.equal(cb.totalLength, 100);
  const total = cb.fields.find((f) => f.name === 'ORD-TOTAL')!;
  assert.deepEqual([total.usage, total.scale, total.digits, total.signed], ['COMP-3', 2, 11, true]);
  assert.equal(cb.fields.find((f) => f.name === 'ORD-RATE')!.usage, 'COMP-2');
  assert.deepEqual(cb.warnings, []);
});

test('多层 OCCURS：下标写成 (i,j)，偏移逐层累加', () => {
  const cb = parseCopybook(`
    01 R.
       05 T OCCURS 2.
          10 U OCCURS 3.
             15 V PIC X(2).
          10 W PIC 9.
  `);
  assert.deepEqual(layout(cb.fields), [
    ['V(1,1)', 0, 2], ['V(1,2)', 2, 2], ['V(1,3)', 4, 2], ['W(1)', 6, 1],
    ['V(2,1)', 7, 2], ['V(2,2)', 9, 2], ['V(2,3)', 11, 2], ['W(2)', 13, 1],
  ]);
  assert.equal(cb.totalLength, 14);
});

test('三层 OCCURS 与组级 USAGE 继承', () => {
  const cb = parseCopybook(`
    01 R.
       05 A OCCURS 2 USAGE COMP-3.
          10 B OCCURS 2.
             15 C OCCURS 2 PIC S9(3).
  `);
  assert.equal(cb.fields.length, 8);
  assert.deepEqual(cb.fields.map((f) => f.name).slice(0, 3), ['C(1,1,1)', 'C(1,1,2)', 'C(1,2,1)']);
  assert.ok(cb.fields.every((f) => f.usage === 'COMP-3' && f.length === 2));
  assert.deepEqual(cb.fields.map((f) => f.offset), [0, 2, 4, 6, 8, 10, 12, 14]);
  assert.equal(cb.totalLength, 16);
});

test('下级项目写明的 USAGE 优先于上级', () => {
  const cb = parseCopybook(`
    01 R.
       05 G COMP-3.
          10 A PIC S9(5).
          10 B PIC S9(4) COMP.
          10 C PIC X(3) USAGE DISPLAY.
  `);
  assert.deepEqual(cb.fields.map((f) => [f.name, f.usage, f.length]), [
    ['A', 'COMP-3', 3],
    ['B', 'COMP', 2],
    ['C', 'DISPLAY', 3],
  ]);
});

test('二进制项目的长度（位数 → 2 / 4 / 8 字节），COMP-1 / COMP-2 无 PIC', () => {
  const cases: Array<[string, string, number]> = [
    ['S9(1)', 'COMP', 2], ['S9(4)', 'COMP', 2], ['S9(5)', 'COMP', 4], ['S9(9)', 'COMP', 4],
    ['S9(10)', 'COMP', 8], ['S9(18)', 'COMP', 8], ['9(4)', 'BINARY', 2], ['9(9)', 'COMP-4', 4],
    ['S9(4)', 'COMP-5', 2], ['S9(18)', 'COMP-5', 8],
    ['S9(1)', 'COMP-3', 1], ['S9(2)', 'COMP-3', 2], ['S9(7)V99', 'PACKED-DECIMAL', 5], ['S9(18)', 'COMP-3', 10],
  ];
  for (const [pic, usage, len] of cases) {
    assert.equal(picInfo(pic, usage, false).length, len, `${pic} ${usage}`);
  }
  const cb = parseCopybook('01 R. 05 F1 COMP-1. 05 F2 USAGE IS COMPUTATIONAL-2. 05 IX USAGE INDEX. 05 X PIC X.');
  assert.deepEqual(layout(cb.fields), [['F1', 0, 4], ['F2', 4, 8], ['IX', 12, 4], ['X', 16, 1]]);
});

test('SIGN 子句：LEADING / TRAILING / SEPARATE，组级 SIGN 由下级继承', () => {
  const cb = parseCopybook(`
    01 R.
       05 G SIGN IS LEADING SEPARATE CHARACTER.
          10 A PIC S9(3).
          10 B PIC 9(3).
       05 C PIC S9(3) SIGN TRAILING SEPARATE.
       05 D PIC S9(3) LEADING.
       05 E PIC S9(3)V9(2).
  `);
  assert.deepEqual(
    cb.fields.map((f) => [f.name, f.offset, f.length, f.signSeparate, f.signLeading]),
    [
      ['A', 0, 4, true, true],
      ['B', 4, 3, false, false], // 无符号项目不受 SIGN 影响
      ['C', 7, 4, true, false],
      ['D', 11, 3, false, true],
      ['E', 14, 5, false, false],
    ]
  );
  assert.equal(cb.totalLength, 19);
});

test('编辑项目、V / P、77 / 66 / 88 层、层级号不连续', () => {
  const cb = parseCopybook(`
    01 R.
       03 A PIC ZZZ9.99-.
       03 B PIC 9(3)PP.
       03 G.
          07 C PIC X(2).
       03 D PIC $$,$$9.
       66 RN RENAMES A THRU B.
       03 E PIC 9.
          88 E-ON VALUE 1.
    77 WS-CNT PIC 9(4).
  `);
  assert.deepEqual(layout(cb.fields), [['A', 0, 8], ['B', 8, 3], ['C', 11, 2], ['D', 13, 6], ['E', 19, 1]]);
  assert.equal(cb.fields[0].type, 'alnum'); // 编辑项目按文字显示
  assert.deepEqual(cb.records.map((r) => [r.name, r.totalLength]), [['R', 20], ['WS-CNT', 4]]);
});

test('REDEFINES：组项目的多种布局，区域大小取最大值，不重复计算', () => {
  const src = `
    01 PAY-REC.
       05 PAY-TYPE          PIC X.
       05 PAY-DETAIL.
          10 CARD-NO        PIC X(16).
          10 CARD-EXP       PIC 9(4).
       05 BANK-DETAIL REDEFINES PAY-DETAIL.
          10 BANK-CODE      PIC 9(4).
          10 BRANCH         PIC 9(3).
          10 ACCOUNT        PIC 9(7).
       05 CASH-DETAIL REDEFINES PAY-DETAIL.
          10 CASH-AMT       PIC S9(9) COMP-3.
       05 PAY-AMT           PIC S9(7)V99 COMP-3.
  `;
  const cb = parseCopybook(src);
  const rec = cb.records[0];
  assert.equal(cb.totalLength, 26); // 1 + max(20, 14, 5) + 5
  assert.deepEqual(rec.sets, [
    { id: 'PAY-REC.PAY-DETAIL', base: 'PAY-DETAIL', options: ['PAY-DETAIL', 'BANK-DETAIL', 'CASH-DETAIL'], offset: 1, length: 20 },
  ]);
  assert.deepEqual(layout(cb.fields), [['PAY-TYPE', 0, 1], ['CARD-NO', 1, 16], ['CARD-EXP', 17, 4], ['PAY-AMT', 21, 5]]);

  const bank = layoutRecord(rec, { 'PAY-REC.PAY-DETAIL': 'BANK-DETAIL' });
  assert.deepEqual(layout(bank.fields), [['PAY-TYPE', 0, 1], ['BANK-CODE', 1, 4], ['BRANCH', 5, 3], ['ACCOUNT', 8, 7], ['PAY-AMT', 21, 5]]);
  assert.equal(bank.totalLength, 26);

  const cash = layoutRecord(rec, { 'PAY-REC.PAY-DETAIL': 'cash-detail' }); // 名称不区分大小写
  assert.deepEqual(layout(cash.fields), [['PAY-TYPE', 0, 1], ['CASH-AMT', 1, 5], ['PAY-AMT', 21, 5]]);

  // 不存在的选择 → 回到原布局
  assert.deepEqual(layoutRecord(rec, { 'PAY-REC.PAY-DETAIL': 'NOPE' }).fields, cb.fields);
});

test('REDEFINES：基本项目、重定义比原项目长、重定义的重定义', () => {
  const cb = parseCopybook(`
    01 R.
       05 DATE-N PIC 9(8).
       05 DATE-X REDEFINES DATE-N.
          10 YYYY PIC 9(4).
          10 MM   PIC 99.
          10 DD   PIC 99.
       05 A PIC X(2).
       05 B REDEFINES A PIC X(5).
       05 C REDEFINES B PIC 9(3).
       05 Z PIC X.
  `);
  const rec = cb.records[0];
  assert.equal(cb.totalLength, 8 + 5 + 1);
  assert.deepEqual(rec.sets.map((x) => [x.id, x.options, x.offset, x.length]), [
    ['R.DATE-N', ['DATE-N', 'DATE-X'], 0, 8],
    ['R.A', ['A', 'B', 'C'], 8, 5],
  ]);
  assert.deepEqual(layout(cb.fields), [['DATE-N', 0, 8], ['A', 8, 2], ['Z', 13, 1]]);
  const alt = layoutRecord(rec, { 'R.DATE-N': 'DATE-X', 'R.A': 'C' });
  assert.deepEqual(layout(alt.fields), [['YYYY', 0, 4], ['MM', 4, 2], ['DD', 6, 2], ['C', 8, 3], ['Z', 13, 1]]);
});

test('REDEFINES 在 OCCURS 中：选择作用于每一次出现', () => {
  const cb = parseCopybook(`
    01 R.
       05 ITEM OCCURS 2.
          10 CODE   PIC X(3).
          10 CODE-N REDEFINES CODE PIC 9(3).
          10 QTY    PIC S9(3) COMP-3.
  `);
  const rec = cb.records[0];
  assert.deepEqual(rec.sets.map((x) => x.id), ['R.ITEM.CODE']);
  assert.equal(cb.totalLength, 10);
  const alt = layoutRecord(rec, { 'R.ITEM.CODE': 'CODE-N' });
  assert.deepEqual(layout(alt.fields), [['CODE-N(1)', 0, 3], ['QTY(1)', 3, 2], ['CODE-N(2)', 5, 3], ['QTY(2)', 8, 2]]);
});

test('嵌套 REDEFINES：内层区域只有在外层选中时才出现', () => {
  const cb = parseCopybook(`
    01 R.
       05 P.
          10 P1 PIC X(4).
       05 Q REDEFINES P.
          10 Q1 PIC X(2).
          10 Q2 REDEFINES Q1 PIC 9(2).
          10 Q3 PIC X(2).
  `);
  const rec = cb.records[0];
  assert.deepEqual(rec.sets.map((x) => x.id), ['R.P']);
  const q = layoutRecord(rec, { 'R.P': 'Q' });
  assert.deepEqual(q.sets.map((x) => x.id), ['R.P', 'R.Q.Q1']);
  const q2 = layoutRecord(rec, { 'R.P': 'Q', 'R.Q.Q1': 'Q2' });
  assert.deepEqual(layout(q2.fields), [['Q2', 0, 2], ['Q3', 2, 2]]);
});

test('REDEFINES 的对象不在前面：提示并忽略，不影响其他字段', () => {
  const cb = parseCopybook(`
    01 R.
       05 A PIC X(2).
       05 B PIC X(3).
       05 C REDEFINES A PIC X(2).
       05 D PIC X.
  `);
  assert.deepEqual(layout(cb.fields), [['A', 0, 2], ['B', 2, 3], ['D', 5, 1]]);
  assert.ok(cb.warnings.some((w) => w.includes('C') && w.includes('A')));
});

test('01 层 REDEFINES：作为同一区域的另一种记录定义', () => {
  const cb = parseCopybook(`
    01 REC-A.
       05 A1 PIC X(10).
    01 REC-B REDEFINES REC-A.
       05 B1 PIC 9(4).
       05 B2 PIC X(6).
  `);
  assert.deepEqual(cb.records.map((r) => [r.name, r.totalLength]), [['REC-A', 10], ['REC-B', 10]]);
});

test('SYNC：给出提示（不计算对齐填充）', () => {
  const cb = parseCopybook('01 R. 05 A PIC X. 05 B PIC S9(9) COMP SYNC.');
  assert.deepEqual(layout(cb.fields), [['A', 0, 1], ['B', 1, 4]]);
  assert.ok(cb.warnings.some((w) => w.includes('SYNC')));
});

test('数值解码端到端：复杂记录的每个字段（COMP-3 小数、COMP、OCCURS、COMP-2、PIC N）', async () => {
  const { RdwSession } = await import('../src/session');
  const { encodeShiftJis } = await import('../src/sjisEncode');
  const { rec, ascii, hexBytes } = await import('./helpers');
  const cb = parseCopybook(`
       01  ORDER-REC.
           05  ORD-KEY.
               10  ORD-TYPE        PIC X(2).
               10  ORD-NO          PIC 9(8).
           05  ORD-DATE            PIC 9(8).
           05  ORD-AMOUNTS         USAGE COMP-3.
               10  ORD-TOTAL       PIC S9(9)V99.
               10  ORD-TAX         PIC S9(7)V99.
           05  ORD-COUNT           PIC S9(4) COMP.
           05  ORD-LINES OCCURS 3 TIMES.
               10  LN-ITEM         PIC X(6).
               10  LN-QTY          PIC S9(5) COMP-3.
               10  LN-PRICE        PIC S9(7)V99 COMP-3.
           05  ORD-FLAG            PIC X OCCURS 4.
           05  ORD-RATE            COMP-2.
           05  ORD-NOTE            PIC N(5).
           05  FILLER              PIC X(5).
  `);
  const rate = Buffer.alloc(8);
  rate.writeDoubleBE(0.08);
  const line = (item: string, qty: string, price: string) => Buffer.concat([ascii(item), hexBytes(qty), hexBytes(price)]);
  const body = Buffer.concat([
    ascii('OR00012345' + '20261113'),
    hexBytes('00 12 34 56 78 9C'), // +1234567.89
    hexBytes('00 00 09 87 6D'), // -98.76
    hexBytes('00 03'),
    line('ITEM01', '00 01 0C', '00 01 50 00 0C'),
    line('ITEM02', '00 00 2C', '00 00 09 99 9C'),
    line('ITEM03', '00 00 0D', '00 00 00 00 0C'),
    ascii('YNYN'),
    rate,
    Buffer.from(encodeShiftJis('受注のメモ').bytes),
    ascii('     '),
  ]);
  assert.equal(body.length, 100);
  const s = new RdwSession(rec(body), 'order.dat');
  s.setCopybook(100, { name: 'order.cpy', copybook: cb });
  const g = s.init().groups[0];
  assert.equal(g.banner.level, 'info');
  const row = s.getRows(g.key, 0, 1)[0] as import('../src/session').RecRow;
  assert.deepEqual(row.c, [
    'OR', '00012345', '20261113', '+1234567.89', '-98.76', '+3',
    'ITEM01', '+10', '+1500.00', 'ITEM02', '+2', '+99.99', 'ITEM03', '-0', '+0.00',
    'Y', 'N', 'Y', 'N', '0.08', '受注のメモ', '     ',
  ]);
  assert.deepEqual(row.w, []);
});

test('固定格式：日文项目名按字节计列，73~80 列的标识区不会混入', () => {
  // 第 8~72 列为代码，第 73~80 列为标识区。全角字符占 2 列，因此按字符数对齐的话会错位。
  const line = (code: string) => {
    let width = 0;
    for (const ch of code) {
      const cp = ch.codePointAt(0)!;
      width += cp < 0x80 || (cp >= 0xff61 && cp <= 0xff9f) ? 1 : 2; // 半角片假名为 1 字节
    }
    return code + ' '.repeat(72 - width) + 'CUST0001';
  };
  const cb = parseCopybook(
    [
      line('000100 01  顧客レコード.'),
      line('000200     05  顧客番号        PIC 9(8).'),
      line('000300     05  顧客名          PIC X(30).'),
      line('000400     05  ｶﾅ名            PIC X(20).'),
    ].join('\n')
  );
  assert.deepEqual(layout(cb.fields), [['顧客番号', 0, 8], ['顧客名', 8, 30], ['ｶﾅ名', 38, 20]]);
  assert.deepEqual(cb.warnings, []);
});
