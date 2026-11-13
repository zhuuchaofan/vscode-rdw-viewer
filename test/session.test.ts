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
