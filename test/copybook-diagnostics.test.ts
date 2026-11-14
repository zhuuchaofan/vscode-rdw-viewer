/**
 * copybook 解析的可信度：无法处理的写法不能静默跳过。
 * 会改变字段位置的（layout）→ 布局不可信，从该位置起的字段标为可疑；只影响数值的（value）→ 部分支持。
 * 以及固定 / 可变格式的续行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopybook, CopyIssue } from '../src/copybook';
import { buildColumns } from '../src/layout';
import { RdwSession, RecRow } from '../src/session';
import { rec } from './helpers';

const layout = (src: string) => {
  const cb = parseCopybook(src);
  const r = cb.records[0];
  return {
    cb,
    trust: r?.trust,
    total: cb.totalLength,
    fields: cb.fields.map((f) => [f.name, f.offset, f.length]),
    suspect: cb.fields.filter((f) => f.suspect).map((f) => f.name),
    issues: (r?.issues ?? []).map((x: CopyIssue) => [x.level, x.from]),
  };
};

/** 固定格式的一行：序号 + 第 7 列 + 内容，补到 72 列后加 73~80 列的标识区（内容须在 72 列以内） */
const L = (indicator: string, body: string) => {
  const line = '000100' + indicator + body;
  assert.ok(line.length <= 72, `测试数据超过 72 列：${line}`);
  return line.padEnd(72, ' ') + 'IDENT001';
};

// ---- 续行 ----

test('续行：PIC 字符串跨行时直接接上（不插入空格）', () => {
  const r = layout([L(' ', ' 01 R.'), L(' ', '     05 A PIC X(1'), L('-', '    0).'), L(' ', '     05 B PIC X.')].join('\n'));
  assert.deepEqual(r.fields, [['A', 0, 10], ['B', 10, 1]]);
  assert.equal(r.trust, 'ok');
});

test('续行：数据名跨行', () => {
  const r = layout([L(' ', ' 01 R.'), L(' ', '     05 LONG-NA'), L('-', '    ME PIC X(3).'), L(' ', '     05 B PIC X.')].join('\n'));
  assert.deepEqual(r.fields, [['LONG-NAME', 0, 3], ['B', 3, 1]]);
});

test('续行：文字字面量跨行时，后面的字段不会被当作字面量吞掉', () => {
  const r = layout(
    [L(' ', ' 01 R.'), L(' ', '     05 A PIC X(20) VALUE "ABCDEFGHIJ'), L('-', '    "KLMNOPQRST".'), L(' ', '     05 B PIC X.')].join('\n')
  );
  assert.deepEqual(r.fields, [['A', 0, 20], ['B', 20, 1]]);
  assert.equal(r.trust, 'ok');
});

test('续行：跨三行的字面量，中间夹注释行；字面量中的 *> 不是注释', () => {
  const r = layout(
    [
      L(' ', ' 01 R.'),
      L(' ', "     05 A PIC X(200) VALUE 'AAAA *> NOT A COMMENT AAAA"),
      L('*', ' 注释行'),
      L('-', "    'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
      L('-', "    'CCC'.  *> real comment"),
      L(' ', '     05 B PIC X.'),
    ].join('\n')
  );
  assert.deepEqual(r.fields, [['A', 0, 200], ['B', 200, 1]]);
  assert.equal(r.trust, 'ok');
});

test('续行：字面量的续行没有以引号开头 → 布局不可信', () => {
  const r = layout([L(' ', ' 01 R.'), L(' ', '     05 A PIC X(20) VALUE "ABCDEFGHIJ'), L('-', '    KLMNOPQRST".'), L(' ', '     05 B PIC X.')].join('\n'));
  assert.equal(r.trust, 'untrusted');
});

test('续行：前面没有可接续的行 → 按普通行处理并提示（不影响位置）', () => {
  const cb = parseCopybook([L('-', ' 01 R.'), L(' ', '     05 A PIC X.')].join('\n'));
  assert.deepEqual(cb.issues.map((x) => x.level), ['note']);
  assert.equal(cb.records[0].trust, 'partial');
});

test('引号没有闭合 → 布局不可信', () => {
  const r = layout(`01 R. 05 A PIC X(3) VALUE 'AB. 05 B PIC X.`);
  assert.equal(r.trust, 'untrusted');
});

test('可变格式：有一行超过 80 列时，不截掉第 73 列以后的内容', () => {
  const r = layout(
    ['000100 01 R.', '000200     05 A PIC X(5).' + ' '.repeat(60) + '05 B PIC X(2).', '000300     05 C PIC X.'].join('\n')
  );
  assert.deepEqual(r.fields, [['A', 0, 5], ['B', 5, 2], ['C', 7, 1]]);
});

// ---- COPY / REPLACE / 无法识别的语句 ----

test('记录中途的 COPY：布局不可信，COPY 之后的字段标为可疑', () => {
  const r = layout(`
    01 CUSTOMER-REC.
       05 CUSTOMER-ID PIC X(10).
       COPY CUSTDTL.
       05 CUSTOMER-STATUS PIC X(1).
  `);
  assert.equal(r.trust, 'untrusted');
  assert.deepEqual(r.issues, [['layout', 10]]);
  assert.deepEqual(r.suspect, ['CUSTOMER-STATUS']);
  assert.ok(r.cb.warnings.some((w) => w.includes('CUSTDTL')));
});

test('组项目中的 COPY：位置为该组中 COPY 出现的地方', () => {
  const r = layout(`
    01 R.
       05 A PIC X(2).
       05 G.
          10 G1 PIC X(3).
          COPY MEMBER.
          10 G2 PIC X.
       05 Z PIC X.
  `);
  assert.deepEqual(r.issues, [['layout', 5]]);
  assert.deepEqual(r.suspect, ['G2', 'Z']);
});

test('记录之外的 COPY：已显示的记录不受影响（部分支持）', () => {
  const r = layout(`COPY OTHER. 01 R. 05 A PIC X.`);
  assert.equal(r.trust, 'partial');
  assert.deepEqual(r.suspect, []);
});

test('REPLACE：可能改写任何地方 → 所有字段可疑', () => {
  const r = layout(`01 R. 05 A PIC X. REPLACE ==X(9)== BY ==X(5)==. 05 C PIC X.`);
  assert.equal(r.trust, 'untrusted');
  assert.deepEqual(r.suspect, ['A', 'C']);
});

test('记录中途无法识别的语句（如 EXEC SQL INCLUDE）：布局不可信', () => {
  const r = layout(`01 R. 05 A PIC X(2). EXEC SQL INCLUDE SQLCA END-EXEC. 05 B PIC X.`);
  assert.equal(r.trust, 'untrusted');
  assert.deepEqual(r.suspect, ['B']);
});

test('层级号前有无法识别的内容（如缺少句点的 COPY）：布局不可信，字段不丢失', () => {
  const r = layout('01 R. 05 A PIC X(2). COPY X 05 B PIC X(3).');
  assert.deepEqual(r.fields, [['A', 0, 2], ['B', 2, 3]]);
  assert.equal(r.trust, 'untrusted');
  assert.deepEqual(r.suspect, ['B']);
});

// ---- 子句 ----

test('无法识别的子句 / USAGE / PIC / OCCURS 次数：布局不可信', () => {
  for (const src of [
    '01 R. 05 A PIC X GROUP-USAGE NATIONAL. 05 B PIC X.',
    '01 R. 05 A PIC X USAGE COMP-X. 05 B PIC X.',
    '01 R. 05 A PIC X(3. 05 B PIC X.',
    '01 R. 05 A OCCURS N TIMES. 10 A1 PIC X. 05 B PIC X.',
  ]) {
    const r = layout(src);
    assert.equal(r.trust, 'untrusted', src);
    assert.ok(r.suspect.includes('B'), `${src}：B 应标为可疑`);
  }
});

test('不影响布局的子句不产生提示', () => {
  const r = layout(`
    01 R.
       05 A PIC X(3) JUSTIFIED RIGHT VALUE 'AB'.
       05 B PIC 9(3) BLANK WHEN ZERO.
       05 T OCCURS 2 TIMES ASCENDING KEY IS K INDEXED BY I1 I2.
          10 K PIC X.
       05 C PIC X(2) EXTERNAL GLOBAL.
       05 Z PIC N(2) CHARACTER TYPE IS MODE-1.
       05 P PIC X(2) PRINTING POSITION IS 10.
       05 S PIC S9(3) SIGN IS LEADING SEPARATE CHARACTER.
       05 Q PIC S9(4) COMP SYNC LEFT.
  `);
  assert.deepEqual(r.cb.warnings, []);
  assert.equal(r.trust, 'ok');
  assert.equal(r.total, 3 + 3 + 2 + 2 + 4 + 2 + 4 + 2); // Q 在偏移 20，已对齐
});

test('REDEFINES 的对象找不到：布局不可信（被忽略的项目可能比原项目长）', () => {
  const r = layout('01 R. 05 A PIC X(2). 05 B PIC X(3). 05 C REDEFINES A PIC X(9). 05 D PIC X.');
  assert.deepEqual(r.fields, [['A', 0, 2], ['B', 2, 3], ['D', 5, 1]]);
  assert.deepEqual(r.issues, [['layout', 5]]);
  assert.deepEqual(r.suspect, ['D']);
});

test('未选中的 REDEFINES 布局中的问题也会报告（会影响区域大小）', () => {
  const r = layout(`
    01 R.
       05 A PIC X(4).
       05 B REDEFINES A.
          10 B1 PIC X FOO.
       05 Z PIC X.
  `);
  assert.equal(r.trust, 'untrusted');
  assert.deepEqual(r.issues, [['layout', 0]]);
});

// ---- SYNC ----

test('SYNC：需要填充时布局不可信（从该项目起可疑）；已对齐时不提示', () => {
  const mis = layout('01 R. 05 A PIC X. 05 B PIC S9(9) COMP SYNC. 05 C PIC X.');
  assert.deepEqual(mis.issues, [['layout', 1]]);
  assert.deepEqual(mis.suspect, ['B', 'C']);
  assert.ok(mis.cb.warnings[0].includes('3'), '需要 3 字节填充');

  const ok = layout('01 R. 05 A PIC X(4). 05 B PIC S9(9) COMP SYNC. 05 C PIC X.');
  assert.equal(ok.trust, 'ok');
});

test('SYNC：对 COMP-3 / DISPLAY 无效（编译器忽略），不提示', () => {
  assert.equal(layout('01 R. 05 A PIC X. 05 B PIC S9(5) COMP-3 SYNC. 05 C PIC X SYNC.').trust, 'ok');
});

test('SYNC：写在组项目上时适用于下级的基本项目；COMP-2 按 8 字节边界', () => {
  assert.deepEqual(layout('01 R. 05 A PIC X. 05 G SYNC. 10 B PIC S9(4) COMP.').issues, [['layout', 1]]);
  assert.deepEqual(layout('01 R. 05 A PIC X(4). 05 D COMP-2 SYNC.').issues, [['layout', 4]]);
  assert.equal(layout('01 R. 05 A PIC X(8). 05 D COMP-2 SYNC.').trust, 'ok');
});

test('SYNC：OCCURS 的每次出现分别检查（第 2 次出现才不对齐）', () => {
  const r = layout('01 R. 05 T OCCURS 2. 10 A PIC X(2). 10 B PIC S9(4) COMP SYNC. 10 C PIC X.');
  // 第 1 次：B 在偏移 2（对齐）；第 2 次：A 在 5，B 在 7（需要填充）
  assert.deepEqual(r.issues, [['layout', 7]]);
  assert.deepEqual(r.suspect, ['B(2)', 'C(2)']);
});

// ---- OCCURS DEPENDING ON ----

test('OCCURS DEPENDING ON 之后还有字段：布局不可信，之后的字段可疑', () => {
  const r = layout('01 R. 05 N PIC 9(2). 05 T OCCURS 1 TO 3 DEPENDING ON N. 10 X PIC X(2). 05 Z PIC X.');
  assert.deepEqual(r.issues, [['layout', 8]]);
  assert.deepEqual(r.suspect, ['Z']);
});

test('OCCURS DEPENDING ON 在记录末尾：位置可靠（部分支持）', () => {
  const r = layout('01 R. 05 N PIC 9(2). 05 T OCCURS 1 TO 3 TIMES DEPENDING ON N OF R. 10 X PIC X(2).');
  assert.equal(r.trust, 'partial');
  assert.deepEqual(r.suspect, []);
});

// ---- USAGE / TYPE / PIC P ----

test('BINARY-CHAR / SHORT / LONG / DOUBLE：长度按类型，值按本地字节序解码', () => {
  const r = layout('01 R. 05 A BINARY-CHAR UNSIGNED. 05 B BINARY-SHORT. 05 C USAGE BINARY-LONG SIGNED. 05 D BINARY-DOUBLE. 05 E PIC X.');
  assert.deepEqual(r.fields, [['A', 0, 1], ['B', 1, 2], ['C', 3, 4], ['D', 7, 8], ['E', 15, 1]]);
  assert.equal(r.trust, 'ok');

  const body = Buffer.from([0xff, 0x2e, 0xfb, 0x2e, 0xfb, 0xff, 0xff, 0xd2, 0x04, 0, 0, 0, 0, 0, 0, 0x41]);
  const s = new RdwSession(rec(body), 't.dat', { comp5Endian: 'little' });
  s.setCopybook(16, { name: 'c.cpy', copybook: r.cb });
  assert.deepEqual((s.getRows('L16', 0, 1)[0] as RecRow).c, ['255', '-1234', '-1234', '+1234', 'A']);
});

test('INDEX / POINTER（64 位环境为 8 字节）、BIT：布局不可信', () => {
  assert.equal(layout('01 R. 05 A INDEX. 05 B PIC X.').trust, 'untrusted');
  assert.equal(layout('01 R. 05 A POINTER. 05 B PIC X.').trust, 'untrusted');
  assert.equal(layout('01 R. 05 A PIC 1(8) BIT. 05 B PIC X.').trust, 'untrusted');
});

test('TYPEDEF 不作为记录；TYPE 引用无法展开 → 布局不可信（只报告一次）', () => {
  const cb = parseCopybook('01 T TYPEDEF. 05 T1 PIC X(5). 01 R. 05 A PIC X. 05 B TYPE T. 05 C PIC X.');
  assert.deepEqual(cb.records.map((r) => r.name), ['R']);
  assert.equal(cb.records[0].trust, 'untrusted');
  assert.equal(cb.records[0].issues.length, 1);
});

test('PIC 中的 P：不占存储；P 在左边时小数位数为 P 与 9 之和，在右边时末尾补 0', () => {
  const r = layout('01 R. 05 A PIC 9(3)P(2). 05 B PIC PP9(2). 05 C PIC SVPP99 COMP-3. 05 D PIC X.');
  assert.deepEqual(r.fields, [['A', 0, 3], ['B', 3, 2], ['C', 5, 2], ['D', 7, 1]]);
  assert.equal(r.trust, 'ok');
  assert.deepEqual(r.cb.fields.map((f) => f.scale), [-2, 4, 4, 0]);

  const body = Buffer.from([0x31, 0x32, 0x33, 0x31, 0x32, 0x01, 0x2d, 0x41]);
  const s = new RdwSession(rec(body), 't.dat');
  s.setCopybook(8, { name: 'p.cpy', copybook: r.cb });
  // 表格中 DISPLAY 数字显示原来的字符，COMP-3 显示解码后的数值；DISPLAY 数字的数值在单元格详情中
  assert.deepEqual((s.getRows('L8', 0, 1)[0] as RecRow).c, ['123', '12', '-0.0012', 'A']);
  assert.equal(s.cellInfo('L8', 0, 0)!.value, '12300');
  assert.equal(s.cellInfo('L8', 0, 1)!.value, '0.0012');
});
// ---- 提示条与列 ----

test('布局不可信：提示条为错误，可疑的列带标记；严格模式下不拆分字段', () => {
  const cb = parseCopybook('01 R. 05 A PIC X(2). COPY M. 05 B PIC X(3).');
  const ref = { name: 'r.cpy', copybook: cb };
  const lenient = buildColumns(5, ref, 'lenient');
  assert.equal(lenient.banner.level, 'error');
  assert.match(lenient.banner.text, /^【布局可能不准确】/);
  assert.match(lenient.banner.text, /COPY M/);
  assert.deepEqual(lenient.columns.map((c) => [c.name, !!c.suspect]), [['A', false], ['B', true]]);

  const strict = buildColumns(5, ref, 'strict');
  assert.equal(strict.banner.level, 'error');
  assert.deepEqual(strict.columns.map((c) => c.kind), ['body']);
});

test('部分支持：提示条为警告；可信：提示条为信息', () => {
  const partial = buildColumns(4, { name: 'p.cpy', copybook: parseCopybook('01 R. 05 N PIC 9(2). 05 T OCCURS 1 TO 2 DEPENDING ON N. 10 X PIC X.') }, 'lenient');
  assert.equal(partial.banner.level, 'warn');
  assert.ok(partial.columns.every((c) => !c.suspect));
  const ok = buildColumns(5, { name: 'o.cpy', copybook: parseCopybook('01 R. 05 A PIC 9(3). 05 B PIC X(2).') }, 'lenient');
  assert.equal(ok.banner.level, 'info');
});

test('提示条只列出选中的 01 记录的问题', () => {
  const cb = parseCopybook('01 H. 05 H1 PIC X(4). 01 D. 05 D1 PIC X. 05 D2 PIC S9(9) COMP SYNC.');
  const h = buildColumns(4, { name: 'x.cpy', copybook: cb }, 'lenient');
  assert.equal(h.banner.level, 'info');
  const d = buildColumns(5, { name: 'x.cpy', copybook: cb }, 'lenient');
  assert.equal(d.banner.level, 'error');
});
