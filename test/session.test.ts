import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RdwSession, RecRow, HdrRow, ErrRow } from '../src/session';
import { parseCopybook } from '../src/copybook';
import { rec, ascii, hexBytes } from './helpers';

const CPY = parseCopybook(`
  01 R.
     05 F1 PIC X(4).
     05 SEP PIC X(1).
     05 F2 PIC 9(3).
`); // 总长 8

function session(file: Buffer, mismatch: 'lenient' | 'strict' = 'lenient'): RdwSession {
  return new RdwSession(file, 'test.dat', { mismatch });
}

test('按长度分组，每组一个 copybook', () => {
  const file = Buffer.concat([rec(ascii('ABCD,123')), rec(ascii('XY')), rec(ascii('EFGH,456'))]);
  const s = session(file);
  assert.deepEqual(s.groups.map((g) => [g.key, g.entries.length]), [
    ['L8', 2],
    ['L2', 1],
  ]);
  s.setCopybook(8, { name: 'a.cpy', copybook: CPY });
  const init = s.init();
  assert.equal(init.groups[0].copybookName, 'a.cpy');
  assert.deepEqual(init.groups[0].columns.map((c) => [c.name, c.start]), [
    ['F1', 1],
    ['SEP', 5],
    ['F2', 6],
  ]);
  assert.equal(init.groups[0].banner.level, 'info');
  // 没有映射的长度显示整条正文，并提示选择 copybook
  assert.equal(init.groups[1].columns[0].name, '(正文)');
  assert.equal(init.groups[1].banner.level, 'warn');

  const rows = s.getRows('L8', 0, 10) as RecRow[];
  assert.deepEqual(rows[1].c, ['EFGH', ',', '456']);
  assert.deepEqual(rows[1].w, []);
});

test('SJIS 解码（日本語 / テスト）', () => {
  const body = Buffer.concat([hexBytes('93FA967B8CEA'), hexBytes('836583588367')]); // 日本語テスト
  const s = session(rec(body));
  const rows = s.getRows('L12', 0, 1) as RecRow[];
  assert.equal(rows[0].c[0], '日本語テスト');
  assert.equal(s.init().encoding, 'shift_jis');
});

test('字段边界切断双字节字符 → 标橙', () => {
  const body = hexBytes('93FA967B8CEA00'); // 7 字节
  const s = session(rec(body));
  s.setCopybook(7, {
    name: 'x.cpy',
    copybook: parseCopybook('01 R. 05 A PIC X(3). 05 B PIC X(4).'),
  });
  const row = s.getRows('L7', 0, 1)[0] as RecRow;
  assert.ok(row.w.includes(0), '第 1 个字段在双字节中间被切断');
});

test('正文比 copybook 长：多出部分进入「(余り)」列', () => {
  const s = session(rec(ascii('ABCD,123ZZ'))); // 10 字节
  s.setCopybook(10, { name: 'a.cpy', copybook: CPY });
  const g = s.init().groups[0];
  assert.equal(g.banner.level, 'warn');
  assert.match(g.banner.text, /多出的 2 字节/);
  assert.equal(g.columns[g.columns.length - 1].name, '(余り)');
  const row = s.getRows('L10', 0, 1)[0] as RecRow;
  assert.equal(row.c[3], 'ZZ');
  assert.deepEqual(row.w, [3]);
});

test('正文比 copybook 短：截断字段标橙，缺失字段显示 —', () => {
  const s = session(rec(ascii('ABCD,1'))); // 6 字节，F2 只有 1/3
  s.setCopybook(6, { name: 'a.cpy', copybook: CPY });
  assert.equal(s.init().groups[0].banner.level, 'warn');
  const row = s.getRows('L6', 0, 1)[0] as RecRow;
  assert.deepEqual(row.c, ['ABCD', ',', '1']);
  assert.deepEqual(row.w, [2]);

  const s2 = session(rec(ascii('ABCD'))); // 4 字节，SEP/F2 缺失
  s2.setCopybook(4, { name: 'a.cpy', copybook: CPY });
  const r2 = s2.getRows('L4', 0, 1)[0] as RecRow;
  assert.deepEqual(r2.c, ['ABCD', '—', '—']);
  assert.deepEqual(r2.w, [1, 2]);
});

test('严格模式：长度不一致时不拆分', () => {
  const s = session(rec(ascii('ABCD,123ZZ')), 'strict');
  s.setCopybook(10, { name: 'a.cpy', copybook: CPY });
  const g = s.init().groups[0];
  assert.equal(g.banner.level, 'error');
  assert.equal(g.columns.length, 1);
  assert.equal(g.columns[0].name, '(正文)');
});

test('数字字段含非数字 → 标橙；符号嵌入末位不报', () => {
  const s = session(
    Buffer.concat([rec(ascii('AB,12X')), rec(ascii('AB,12J')), rec(ascii('AB,123'))]),
  );
  s.setCopybook(6, {
    name: 'n.cpy',
    copybook: parseCopybook('01 R. 05 A PIC X(2). 05 S PIC X. 05 N PIC S9(3).'),
  });
  const rows = s.getRows('L6', 0, 3) as RecRow[];
  assert.deepEqual(rows[0].w, [2]); // X 不是合法的 overpunch 字符
  assert.deepEqual(rows[1].w, []); // J = -1 的 overpunch
  assert.deepEqual(rows[2].w, []);
});

test('文件顺序视图：copybook 切换处插入 3 行表头，错误行内联', () => {
  const file = Buffer.concat([
    rec(ascii('ABCD,123')),
    rec(ascii('ABCD,124')),
    rec(ascii('BAD!'), { back: 9 }),
    rec(ascii('XY')),
    rec(ascii('ABCD,125')),
  ]);
  const s = session(file);
  const total = s.count('ORDER');
  // 8: 3表头+2记录 | 错误1 | 2: 3表头+1记录 | 8: 3表头+1记录 = 5+1+4+4
  assert.equal(total, 14);
  const rows = s.getRows('ORDER', 0, total);
  assert.deepEqual(
    rows.map((r) => (r.t === 'hdr' ? `H${(r as HdrRow).g}:${(r as HdrRow).k}` : r.t === 'err' ? 'E' : 'R')),
    ['HL8:0', 'HL8:1', 'HL8:2', 'R', 'R', 'E', 'HL2:0', 'HL2:1', 'HL2:2', 'R', 'HL8:0', 'HL8:1', 'HL8:2', 'R']
  );
  const err = rows[5] as ErrRow;
  assert.match(err.c[2], /前后不一致/);
  assert.equal(s.count('ERR'), 1);
});

test('切换编码', () => {
  const s = session(rec(Buffer.from('テスト', 'utf8')));
  s.setEncoding('utf-8');
  const row = s.getRows('L9', 0, 1)[0] as RecRow;
  assert.equal(row.c[0], 'テスト');
  assert.equal(s.setEncoding('no-such-encoding'), false);
});

test('单元格详情：十六进制字节', () => {
  const s = session(rec(ascii('ABCD,123')));
  s.setCopybook(8, { name: 'a.cpy', copybook: CPY });
  const info = s.cellInfo('L8', 0, 0)!;
  assert.equal(info.hex, '41 42 43 44');
  assert.equal(info.name, 'F1');
  assert.equal(info.start, 1);
});

test('COMP-3 / COMP 字段解码成数值，非法内容回退十六进制并标橙', () => {
  const cb = parseCopybook(`
    01 R.
       05 ID    PIC S9(005) COMP-3.
       05 K     PIC 9(001).
       05 NAME  PIC X(009).
       05 AMT   PIC S9(007)V99 COMP-3.
       05 CNT   PIC S9(004) COMP.
  `); // 3 + 1 + 9 + 5 + 2 = 20
  const row = (id: string, amt: string, cnt: string) =>
    rec(Buffer.concat([hexBytes(id), ascii('1FVAO-M006'), hexBytes(amt), hexBytes(cnt)]));
  const file = Buffer.concat([
    row('11 80 0C', '00 12 34 56 7C', '00 7B'),
    row('00 00 0D', '00 00 00 00 5D', 'FF FF'),
    row('00 00 0F', '00 00 00 00 50', '00 01'), // AMT 符号位为 0 → 非法
  ]);
  const s = session(file);
  s.setCopybook(20, { name: 'c.cpy', copybook: cb });
  const g = s.init().groups[0];
  assert.equal(g.banner.level, 'info');
  assert.deepEqual(g.columns.map((c) => c.usage), ['COMP-3', 'DISPLAY', 'DISPLAY', 'COMP-3', 'COMP']);
  const rows = s.getRows('L20', 0, 3) as RecRow[];
  assert.deepEqual(rows[0].c, ['+11800', '1', 'FVAO-M006', '+12345.67', '+123']);
  assert.deepEqual(rows[0].w, []);
  assert.deepEqual([rows[1].c[0], rows[1].c[3], rows[1].c[4]], ['-0', '-0.05', '-1']);
  assert.equal(rows[2].c[0], '+0');
  assert.equal(rows[2].c[3], '00 00 00 00 50');
  assert.deepEqual(rows[2].w, [3]);
  // 小端设置：00 7B → 0x7B00 = 31488
  const s2 = new RdwSession(file, 't.dat', { binaryEndian: 'little' });
  s2.setCopybook(20, { name: 'c.cpy', copybook: cb });
  assert.equal((s2.getRows('L20', 0, 1)[0] as RecRow).c[4], '+31488');
});

test('多个 01：按记录长度自动选用对应定义，并在提示条中说明', () => {
  const cb = parseCopybook(`
    01 HDR-REC.
       05 H1 PIC X(4).
    01 DATA-REC.
       05 D1 PIC X(3).
       05 D2 PIC X(5).
  `);
  const s = session(Buffer.concat([rec(ascii('ABCDEFGH')), rec(ascii('WXYZ'))]));
  s.setCopybook(8, { name: 'm.cpy', copybook: cb });
  s.setCopybook(4, { name: 'm.cpy', copybook: cb });
  const init = s.init();
  const g8 = init.groups.find((g) => g.length === 8)!;
  const g4 = init.groups.find((g) => g.length === 4)!;
  assert.deepEqual(g8.columns.map((c) => c.name), ['D1', 'D2']);
  assert.equal(g8.banner.level, 'info');
  assert.match(g8.banner.text, /选用 DATA-REC/);
  assert.deepEqual(g4.columns.map((c) => c.name), ['H1']);
});

test('没有 copybook：正文自动识别 COMP-3；关闭开关后按原样解码', () => {
  const body = Buffer.concat([hexBytes('11 80 0C'), ascii('1FVAO-M006'), hexBytes('22 50 93 0C')]);
  const s = session(rec(body));
  const len = body.length;
  assert.equal(s.init().autoPacked, true);
  const row = s.getRows(`L${len}`, 0, 1)[0] as RecRow;
  assert.equal(row.c[0], '+118001FVAO-M006+2250930');
  assert.deepEqual(row.w, []);
  assert.equal(s.cellInfo(`L${len}`, 0, 0)!.text, '[+11800]1FVAO-M006[+2250930]');

  s.setAutoPacked(false);
  const off = s.getRows(`L${len}`, 0, 1)[0] as RecRow;
  assert.ok(!off.c[0].includes(''));
  // 指定 copybook 后不再自动识别
  s.setAutoPacked(true);
  s.setCopybook(len, { name: 'x.cpy', copybook: parseCopybook(`01 R. 05 A PIC S9(5) COMP-3. 05 B PIC X(10). 05 C PIC S9(7) COMP-3.`) });
  assert.deepEqual((s.getRows(`L${len}`, 0, 1)[0] as RecRow).c, ['+11800', '1FVAO-M006', '+2250930']);
});

test('判别字段（COMP-3）：同一长度按字段值分组，各自使用不同 copybook', () => {
  // 长度都是 8：前 3 字节为 COMP-3 的记录类型
  const hdr = (s: string) => rec(Buffer.concat([hexBytes('11 80 0C'), ascii(s)]));
  const dat = (s: string) => rec(Buffer.concat([hexBytes('11 85 0C'), ascii(s)]));
  const file = Buffer.concat([hdr('HEAD1'), dat('A1234'), dat('B5678'), rec(Buffer.concat([hexBytes('99 99 9C'), ascii('ZZZZZ')]))]);
  const s = session(file);
  assert.deepEqual(s.groups.map((g) => g.key), ['L8']);

  const d = { start: 1, length: 3, type: 'comp3' as const };
  assert.deepEqual(s.discriminatorValues(8, d), [
    { value: '+11850', count: 2 },
    { value: '+11800', count: 1 },
    { value: '+99999', count: 1 },
  ]);

  s.setDiscriminator(8, d);
  const cbHdr = parseCopybook('01 H. 05 TYP PIC S9(5) COMP-3. 05 TITLE PIC X(5).');
  const cbDat = parseCopybook('01 D. 05 TYP PIC S9(5) COMP-3. 05 KIND PIC X(1). 05 NUM PIC 9(4).');
  s.setCopybook(8, { name: 'h.cpy', copybook: cbHdr }, undefined, '+11800');
  s.setCopybook(8, { name: 'd.cpy', copybook: cbDat }, undefined, '+11850');

  const init = s.init();
  assert.deepEqual(init.groups.map((g) => [g.value, g.count, g.copybookName]), [
    ['+11800', 1, 'h.cpy'],
    ['+11850', 2, 'd.cpy'],
    ['+99999', 1, null],
  ]);
  assert.match(init.groups[0].banner.text, /位置 1~3（COMP-3） = \+11800/);
  // 未匹配的值：整条正文，提示选择 copybook
  assert.equal(init.groups[2].columns[0].kind, 'body');

  const datKey = init.groups[1].key;
  assert.deepEqual((s.getRows(datKey, 0, 2) as RecRow[]).map((r) => r.c), [
    ['+11850', 'A', '1234'],
    ['+11850', 'B', '5678'],
  ]);
  // 文件顺序视图：分组切换处插入表头
  const order = s.getRows('ORDER', 0, s.count('ORDER')).map((r) => r.t);
  assert.deepEqual(order, ['hdr', 'hdr', 'hdr', 'rec', 'hdr', 'hdr', 'hdr', 'rec', 'rec', 'hdr', 'hdr', 'hdr', 'rec']);

  // 取消区分：回到按长度分组；再次区分时之前指定的 copybook 仍然有效
  s.setDiscriminator(8, null);
  assert.deepEqual(s.groups.map((g) => g.key), ['L8']);
  s.setDiscriminator(8, d);
  assert.equal(s.init().groups[1].copybookName, 'd.cpy');
});

test('判别字段（文字）：去掉末尾空格；超出记录长度时单独成组', () => {
  const file = Buffer.concat([rec(ascii('01 AAAA')), rec(ascii('02 BBBB')), rec(ascii('01 CCCC')), rec(ascii('X'))]);
  const s = session(file);
  s.setDiscriminator(7, { start: 1, length: 3, type: 'text' });
  assert.deepEqual(s.init().groups.map((g) => [g.length, g.value, g.count]), [
    [7, '01', 2],
    [7, '02', 1],
    [1, null, 1],
  ]);
  // 判别字段超出记录长度
  s.setDiscriminator(1, { start: 1, length: 2, type: 'text' });
  assert.equal(s.init().groups.find((g) => g.length === 1)!.value, '(超出记录长度)');
});
