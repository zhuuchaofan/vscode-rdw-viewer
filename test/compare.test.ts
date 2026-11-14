import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RdwSession } from '../src/session';
import { CompareSession, PairRow, PairHdr, counterpartColumn } from '../src/compare';
import { parseCopybook } from '../src/copybook';
import { dumpChars } from '../src/decode';
import { rec, ascii } from './helpers';

/** 旧实现（字符串键 + 队列）的简化版，用来对照按键配对的结果 */
function referencePairs(a: string[], b: string[], keyLen: number): Array<[string | null, string | null]> {
  const queue = new Map<string, number[]>();
  b.forEach((r, j) => {
    if (r.length < keyLen) return;
    const k = r.slice(0, keyLen);
    queue.get(k)?.push(j) ?? queue.set(k, [j]);
  });
  const match = a.map((r) => (r.length < keyLen ? -1 : queue.get(r.slice(0, keyLen))?.shift() ?? -1));
  const used = new Set(match.filter((j) => j >= 0));
  const out: Array<[string | null, string | null]> = [];
  let nb = 0;
  const flush = (upto: number) => {
    for (; nb < upto; nb++) if (!used.has(nb)) out.push([null, b[nb]]);
  };
  a.forEach((r, i) => {
    const j = match[i];
    if (j >= 0 && j >= nb) {
      flush(j);
      nb = j + 1;
    }
    out.push([r, j >= 0 ? b[j] : null]);
  });
  flush(b.length);
  return out;
}

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

test('按键配对：随机数据（重复键、缺失、乱序、过短的记录）与参照实现一致', () => {
  let seed = 12345;
  const rnd = (n: number) => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return (seed >>> 8) % n;
  };
  const make = (n: number) =>
    Array.from({ length: n }, (_, i) => {
      if (rnd(25) === 0) return 'K'; // 比键短
      return `K${String(rnd(40)).padStart(2, '0')}` + String(i % 7) + 'x'.repeat(rnd(3));
    });
  for (let round = 0; round < 30; round++) {
    const ra = make(rnd(120));
    const rb = make(rnd(120));
    const sa = new RdwSession(Buffer.concat(ra.map((r) => rec(ascii(r)))), 'a.dat');
    const sb = new RdwSession(Buffer.concat(rb.map((r) => rec(ascii(r)))), 'b.dat');
    const c = new CompareSession(sa, sb);
    c.configure('key', [{ start: 1, length: 3 }]);
    const got: Array<[string | null, string | null]> = [];
    const text = (s: RdwSession, e: number) => (e < 0 ? null : Buffer.from(s.body(e)).toString('latin1'));
    for (let p = 0; p < c.getStats().pairs; p++) {
      const pr = c.pair(p);
      got.push([text(sa, pr.a), text(sb, pr.b)]);
      const want = pr.a < 0 ? 'b' : pr.b < 0 ? 'a' : text(sa, pr.a) === text(sb, pr.b) ? 'same' : 'chg';
      assert.equal(pr.st, want);
    }
    assert.deepEqual(got, referencePairs(ra, rb, 3), `round ${round}`);
  }
});

test('多个键项目：各部分分别比较，不会因拼接而混淆', () => {
  // 键 = 位置 1~2 + 位置 5~6
  const a = new RdwSession(Buffer.concat([rec(ascii('AB..CD1')), rec(ascii('AB..CE2'))]), 'a.dat');
  const b = new RdwSession(Buffer.concat([rec(ascii('AB!!CE2')), rec(ascii('AB!!CD9')), rec(ascii('ABCD..3'))]), 'b.dat');
  const c = new CompareSession(a, b);
  c.configure('key', [{ start: 1, length: 2 }, { start: 5, length: 2 }]);
  const s = c.getStats();
  assert.deepEqual([s.pairs, s.chg, s.a, s.b], [3, 2, 0, 1]);
  assert.deepEqual([c.pair(0).b, c.pair(1).b], [1, 0]); // A 的两条分别对上 B 的第 2、1 条
});

test('configureAsync：结果与同步相同；取消时保留原来的结果', async () => {
  const recs = (n: number, shift: number) =>
    Buffer.concat(Array.from({ length: n }, (_, i) => rec(ascii(String((i + shift) % n).padStart(6, '0') + (i % 5 === 0 ? 'X' : 'Y')))));
  const n = 60000;
  const a = new RdwSession(recs(n, 0), 'a.dat');
  const b = new RdwSession(recs(n, 7), 'b.dat');
  const sync = new CompareSession(a, b);
  sync.configure('key', [{ start: 1, length: 6 }]);

  const c = new CompareSession(a, b, false);
  assert.equal(c.getStats().pairs, 0); // 尚未比较
  const seen: number[] = [];
  assert.equal(await c.configureAsync('index', [], { onProgress: (f) => seen.push(f), sliceMs: 0 }), true);
  const indexStats = c.getStats();
  assert.equal(indexStats.pairs, n);
  assert.ok(seen.length > 1);
  assert.ok(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1])));

  // 第一次交回控制权时就取消：模式和结果都不变
  let asked = 0;
  assert.equal(await c.configureAsync('key', [{ start: 1, length: 6 }], { isCancelled: () => ++asked > 0, sliceMs: 0 }), false);
  assert.equal(c.mode, 'index');
  assert.deepEqual(c.getStats(), indexStats);

  assert.equal(await c.configureAsync('key', [{ start: 1, length: 6 }]), true);
  assert.equal(c.mode, 'key');
  assert.deepEqual(c.getStats(), sync.getStats());
  assert.deepEqual(c.getRows(false, 0, 200), sync.getRows(false, 0, 200));
  assert.deepEqual(c.getRows(true, 0, 200), sync.getRows(true, 0, 200));
});

test('忽略字段：只有被忽略的字段不同时算作相同；有差异的列中不含被忽略的字段', () => {
  // ID PIC X(3) / NAME PIC X(4) / AMT PIC 9(3)
  const a = session(['001AAAA100', '002BBBB200', '003CCCC300']);
  const b = session(['001AAAA101', '002XXXX201', '003CCCC300']);
  const c = new CompareSession(a, b);
  assert.deepEqual(pairs(c).map((x) => x[2]), ['chg', 'chg', 'same']);

  c.configure('index', [], ['amt']);
  assert.deepEqual(c.ignore, ['AMT']);
  assert.deepEqual(pairs(c).map((x) => x[2]), ['same', 'chg', 'same']);
  const row = c.getRows(true, 0, 10).find((r) => r.t === 'pair') as PairRow;
  assert.deepEqual([row.da, row.db], [[1], [1]]); // 只有 NAME
  assert.equal(c.init().ignore[0], 'AMT');

  // 不改变忽略设置时沿用
  c.configure('key', [{ start: 1, length: 3 }]);
  assert.deepEqual(c.ignore, ['AMT']);
  assert.equal(c.getStats().same, 2);
});

test('忽略字段：OCCURS 的各次出现一并忽略；布局不同时按名称', () => {
  const occ = parseCopybook('01 R. 05 ID PIC X(2). 05 V OCCURS 2 PIC 9(2).'); // 6 字节
  const mk = (recs: string[]) => {
    const s = new RdwSession(Buffer.concat(recs.map((r) => rec(ascii(r)))), 'o.dat');
    s.setCopybook(6, { name: 'o.cpy', copybook: occ });
    return s;
  };
  const c = new CompareSession(mk(['AA1122']), mk(['AA3344']));
  c.configure('index', [], ['V']);
  assert.equal(c.getStats().same, 1);

  // 布局不同（B 多一个字段 EXTRA）：按名称对应，忽略 EXTRA 和 AMT
  const other = parseCopybook('01 R. 05 ID PIC X(3). 05 NAME PIC X(4). 05 EXTRA PIC X. 05 AMT PIC 9(3).'); // 11 字节
  const bs = new RdwSession(Buffer.concat([rec(ascii('001AAAAZ999'))]), 'b.dat');
  bs.setCopybook(11, { name: 'x.cpy', copybook: other });
  const d = new CompareSession(session(['001AAAA100']), bs);
  assert.equal(d.getStats().chg, 1);
  d.configure('index', [], ['EXTRA', 'AMT']);
  assert.equal(d.getStats().same, 1);
});

test('忽略字段：异步比较的结果与同步相同', async () => {
  const a = session(['001AAAA100', '002BBBB200']);
  const b = session(['001AAAA101', '002BBBB200']);
  const c = new CompareSession(a, b, false);
  assert.equal(await c.configureAsync('index', [], {}, ['AMT']), true);
  assert.equal(c.getStats().same, 2);
});

test('差异报告：每个有差异的字段一行，只在一侧的记录一行；CSV 转义', async () => {
  const { diffReportChunks } = await import('../src/compareReport');
  const a = session(['001AAAA100', '002B,BB200', '004DDDD400']);
  const b = session(['001AAAA101', '002B"BB201', '003CCCC300']);
  const c = new CompareSession(a, b);
  c.configure('key', [{ start: 1, length: 3 }]);
  const chunks = [...diffReportChunks(c, 'csv', 1)];
  const text = chunks.map((x) => x.text).join('');
  const lines = text.trimEnd().split('\r\n');
  assert.equal(lines[0], '配对序号,状态,A 记录序号,B 记录序号,字段,位置,A 的值,B 的值');
  assert.deepEqual(lines.slice(1), [
    '1,有差异,1,1,AMT,8,100,101',
    '2,有差异,2,2,NAME,4,"B,BB","B""BB"',
    '2,有差异,2,2,AMT,8,200,201',
    '3,只在 A,3,,,,,',
    '4,只在 B,,3,,,,',
  ]);
  assert.equal(chunks[chunks.length - 1].rows, 5);
  assert.equal(chunks[chunks.length - 1].done, 4);
});
