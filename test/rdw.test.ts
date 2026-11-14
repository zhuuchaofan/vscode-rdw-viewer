import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRdw, scanRdwAsync } from '../src/rdw';
import { rec, ascii } from './helpers';

test('正常记录：长度、偏移', () => {
  const file = Buffer.concat([rec(ascii('ABC')), rec(ascii('HELLO')), rec([])]);
  const idx = scanRdw(file);
  assert.equal(idx.count, 3);
  assert.deepEqual(Array.from(idx.lengths), [3, 5, 0]);
  assert.deepEqual(Array.from(idx.offsets), [0, 11, 11 + 13]);
  assert.equal(idx.errors.size, 0);
});

test('RDW 后 2 字节不影响长度判断', () => {
  const b = rec(ascii('ABC'));
  b[2] = 0xff;
  b[3] = 0xee;
  const idx = scanRdw(b);
  assert.equal(idx.count, 1);
  assert.equal(idx.isError[0], 0);
});

test('前后 RDW 不一致，但边界可信：整条标错并继续', () => {
  const file = Buffer.concat([rec(ascii('AAA')), rec(ascii('BBBB'), { back: 9 }), rec(ascii('CC'))]);
  const idx = scanRdw(file);
  assert.equal(idx.count, 3);
  assert.deepEqual(Array.from(idx.isError), [0, 1, 0]);
  assert.match(idx.errors.get(1)!, /前置 RDW 长度=4.*长度=9.*不一致/);
  assert.equal(idx.lengths[2], 2);
});

test('文件末尾截断', () => {
  const full = rec(ascii('ABCDEFGH'));
  const file = Buffer.concat([rec(ascii('OK')), full.subarray(0, full.length - 5)]);
  const idx = scanRdw(file);
  assert.deepEqual(Array.from(idx.isError), [0, 1]);
  assert.match(idx.errors.get(1)!, /截断/);
});

test('文件末尾残留不足 8 字节', () => {
  const file = Buffer.concat([rec(ascii('OK')), Buffer.from([1, 2, 3])]);
  const idx = scanRdw(file);
  assert.equal(idx.count, 2);
  assert.match(idx.errors.get(1)!, /不足一条记录/);
});

test('前置长度写错（过大）后能重新对齐', () => {
  const bad = rec(ascii('XXXX'), { front: 60000, back: 4 });
  const file = Buffer.concat([rec(ascii('AA')), bad, rec(ascii('BBB')), rec(ascii('CCC'))]);
  const idx = scanRdw(file);
  const oks = Array.from(idx.isError).filter((x) => x === 0).length;
  assert.ok(oks >= 3, `应至少恢复 3 条正常记录，实际 ${oks}`);
  assert.equal(idx.isError[1], 1);
  assert.match(idx.errors.get(1)!, /重新找到记录边界/);
});

test('空文件', () => {
  const idx = scanRdw(Buffer.alloc(0));
  assert.equal(idx.count, 0);
});

test('坏记录之后紧接着文件被截断：中间的正常记录仍能找回', () => {
  const ok = (s: string) => rec(ascii(s.padEnd(8)));
  const tail = ok('TAIL');
  const file = Buffer.concat([
    ok('A'),
    rec(ascii('BADLEN..'), { front: 9000, back: 8 }),
    ok('B'),
    tail.subarray(0, tail.length - 5),
  ]);
  const idx = scanRdw(file);
  // A, 错误(长度), B, 错误(截断)
  assert.deepEqual(Array.from(idx.isError), [0, 1, 0, 1]);
  assert.match(idx.errors.get(1)!, /重新找到记录边界/);
  assert.match(idx.errors.get(3)!, /截断/);
});

test('scanRdwAsync：损坏区域的重新对齐途中也会交回控制权，可以取消；结果与同步扫描相同', async () => {
  // 约 300KB 无法对齐的数据 + 两条正常记录，重复 3 次：
  // 条目很少，按条目数计数的话整个扫描不会交回控制权
  const garbage = Buffer.alloc(300 * 1024);
  let seed = 42;
  for (let i = 0; i < garbage.length; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    garbage[i] = seed >>> 24; // 固定种子的伪随机字节：前后 RDW 对不上
  }
  const good = Buffer.concat([rec(ascii('AAAA')), rec(ascii('BBBB'))]);
  const buf = Buffer.concat([garbage, good, garbage, good, garbage, good]);
  const sync = scanRdw(buf);
  // 6 条正常记录（正文 4 字节）都找回来了（伪随机数据里偶尔会有碰巧自洽的「记录」，不计）
  assert.equal(sync.lengths.filter((len, e) => len === 4 && !sync.isError[e]).length, 6);
  assert.ok(sync.errors.size >= 3);

  const seen: number[] = [];
  const index = await scanRdwAsync(buf, { sliceMs: 0, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length >= 9, `只交回了 ${seen.length} 次`);
  assert.ok(seen.every((f, i) => f >= 0 && f <= 1 && (i === 0 || f >= seen[i - 1])));
  assert.deepEqual(index, sync);

  // 途中取消：第 3 次询问（开始前 1 次 + 交回控制权 2 次）时取消，之后不再继续
  let asked = 0;
  assert.equal(await scanRdwAsync(buf, { sliceMs: 0, isCancelled: () => ++asked >= 3 }), undefined);
  assert.equal(asked, 3);
  // 开始前已取消：不扫描
  assert.equal(await scanRdwAsync(buf, { isCancelled: () => true }), undefined);
});
