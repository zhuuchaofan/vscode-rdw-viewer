import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RdwSession } from '../src/session';
import { CompareSession, PairRow, PairHdr, counterpartColumn } from '../src/compare';
import { parseCopybook } from '../src/copybook';
import { dumpChars } from '../src/decode';
import { rec, ascii } from './helpers';

const CPY = parseCopybook(`
  01 R.
     05 ID   PIC X(3).
     05 NAME PIC X(4).
     05 AMT  PIC 9(3).
`); // 总长 10

function session(recs: string[], name = 'x.dat', extra: Buffer[] = []): RdwSession {
  const s = new RdwSession(Buffer.concat([...recs.map((r) => rec(ascii(r))), ...extra]), name);
  s.setCopybook(10, { name: 'r.cpy', copybook: CPY });
  return s;
}

const pairs = (c: CompareSession, onlyDiff = false) =>
  (c.getRows(onlyDiff, 0, 1000).filter((r) => r.t === 'pair') as PairRow[]).map((r) => [
    r.a ? r.a.c[0] : null,
    r.b ? r.b.c[0] : null,
    r.st,
  ]);

test('按记录序号比较：相同 / 有差异 / 只在一侧', () => {
  const a = session(['001AAAA100', '002BBBB200', '003CCCC300']);
  const b = session(['001AAAA100', '002BBBX201']);
  const c = new CompareSession(a, b);
  assert.deepEqual(pairs(c), [
    ['001', '001', 'same'],
    ['002', '002', 'chg'],
    ['003', null, 'a'],
  ]);
  assert.deepEqual(c.getStats(), { pairs: 3, same: 1, chg: 1, a: 1, b: 0, noKeyA: 0, noKeyB: 0 });
  // 同一布局按字节比较列：NAME 和 AMT 不同
  const row = c.getRows(false, 1, 1)[0] as PairRow;
  assert.deepEqual(row.da, [1, 2]);
  assert.deepEqual(row.db, [1, 2]);
  // 只显示差异
  assert.deepEqual(pairs(c, true).map((p) => p[2]), ['chg', 'a']);
  assert.equal(c.count(true), 2);
});

test('按键项目比较：插入、删除、顺序变化', () => {
  const a = session(['001AAAA100', '002BBBB200', '003CCCC300', '005EEEE500']);
  const b = session(['001AAAA100', '003CCCC999', '004DDDD400', '002BBBB200']);
  const c = new CompareSession(a, b);
  c.configure('key', [{ start: 1, length: 3 }]);
  assert.equal(c.mode, 'key');
  // 显示顺序以 A 为准；只在 B 的 004 出现在 B 中它所在的位置（002 之前）
  assert.deepEqual(pairs(c), [
    ['001', '001', 'same'],
    [null, '004', 'b'],
    ['002', '002', 'same'],
    ['003', '003', 'chg'],
    ['005', null, 'a'],
  ]);
  const st = c.getStats();
  assert.equal(st.same, 2);
  assert.equal(st.chg, 1);
  assert.equal(st.a, 1);
  assert.equal(st.b, 1);
});

test('键项目重复时按出现顺序配对；超出长度的记录不配对', () => {
  const a = session(['001AAAA100', '001AAAA101', 'XY']);
  const b = session(['001AAAA101', '001AAAA100', 'XY']);
  const c = new CompareSession(a, b);
  c.configure('key', [{ start: 1, length: 3 }, { start: 8, length: 3 }]);
  // 键 = ID + AMT：两条都能配对（顺序不同）
  const ps = pairs(c);
  assert.equal(ps.filter((p) => p[2] === 'same').length, 2);
  // 长度 2 的记录取不到键
  assert.equal(c.getStats().noKeyA, 1);
  assert.equal(c.getStats().noKeyB, 1);
  assert.equal(c.getStats().a, 1);
  assert.equal(c.getStats().b, 1);
});

test('分组组合变化时插入表头行；只有一种组合时不插入', () => {
  const a = session(['001AAAA100', '002BBBB200']);
  const b = session(['001AAAA100', '002BBBB201']);
  const c1 = new CompareSession(a, b);
  assert.equal(c1.init().inline, false);
  assert.equal(c1.getRows(false, 0, 10).filter((r) => r.t === 'hdr').length, 0);

  const a2 = session(['001AAAA100', 'XY', '002BBBB200']);
  const b2 = session(['001AAAA100', 'XY', '002BBBB200']);
  const c2 = new CompareSession(a2, b2);
  const init = c2.init();
  assert.equal(init.inline, true);
  const rows = c2.getRows(false, 0, 100);
  assert.deepEqual(
    rows.map((r) => (r.t === 'hdr' ? `H${(r as PairHdr).k}:${(r as PairHdr).ga}` : 'P')),
    ['H0:L10', 'H1:L10', 'H2:L10', 'P', 'H0:L2', 'H1:L2', 'H2:L2', 'P', 'H0:L10', 'H1:L10', 'H2:L10', 'P']
  );
});

test('查找下一处 / 上一处差异', () => {
  const a = session(['001AAAA100', '002BBBB200', '003CCCC300', '004DDDD400']);
  const b = session(['001AAAA100', '002BBBB201', '003CCCC300', '004DDDD401']);
  const c = new CompareSession(a, b);
  assert.equal(c.findDiff(false, -1, 1), 1);
  assert.equal(c.findDiff(false, 1, 1), 3);
  assert.equal(c.findDiff(false, 3, 1), -1);
  assert.equal(c.findDiff(false, 3, -1), 1);
  assert.equal(c.findDiff(true, -1, 1), 0);
});

test('布局不同时按项目名对应列', () => {
  const a = session(['001AAAA100']);
  const b = new RdwSession(rec(ascii('001AAAA100XX')), 'y.dat');
  b.setCopybook(12, {
    name: 'r2.cpy',
    copybook: parseCopybook('01 R. 05 ID PIC X(3). 05 NAME PIC X(4). 05 AMT PIC 9(3). 05 NEW PIC X(2).'),
  });
  const c = new CompareSession(a, b);
  const row = c.getRows(false, 0, 1)[0] as PairRow;
  assert.equal(row.st, 'chg');
  assert.deepEqual(row.da, []);
  assert.deepEqual(row.db, [3]); // NEW 只在 B
  const ga = a.groups[0].columns;
  const gb = b.groups[0].columns;
  assert.equal(counterpartColumn(ga, 2, gb), 2);
  assert.equal(counterpartColumn(gb, 3, ga), -1);
  const cell = c.cellPair(0, 'a', 1);
  assert.equal(cell.a?.text, 'AAAA');
  assert.equal(cell.b?.text, 'AAAA');
});

test('dump：前后 RDW、字段范围、错误条目', () => {
  const bad = Buffer.from([0x05, 0x00, 0x00, 0x00, 0x41, 0x42]); // 被截断
  const s = session(['001AAAA100'], 'x.dat', [bad]);
  const d = s.recordDump(0)!;
  assert.equal(d.front, '0A 00 00 00');
  assert.equal(d.back, '0A 00 00 00');
  assert.equal(d.bytes.length, 10);
  assert.deepEqual(d.fields.map((f) => [f.name, f.start, f.len]), [
    ['ID', 1, 3],
    ['NAME', 4, 4],
    ['AMT', 8, 3],
  ]);
  const errEntry = [...Array(s.index.count).keys()].find((e) => s.index.isError[e])!;
  const de = s.recordDump(errEntry)!;
  assert.ok(de.error);
  assert.equal(de.front, null);
  assert.deepEqual(de.bytes, [...bad]);
});

test('dumpChars：Shift_JIS 双字节字符放在首字节，控制字符为 .', () => {
  const dec = new TextDecoder('shift_jis');
  const bytes = Uint8Array.from([0x41, 0x82, 0xa0, 0xb1, 0x00, 0x0d, 0x81]);
  assert.deepEqual(dumpChars(bytes, dec), ['A', 'あ', '', 'ｱ', '.', '.', '.']);
  const u8 = new TextDecoder('utf-8');
  assert.deepEqual(dumpChars(Uint8Array.from([0xe3, 0x81, 0x82, 0x20]), u8), ['あ', '', '', ' ']);
});
