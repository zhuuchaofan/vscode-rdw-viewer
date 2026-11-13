import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanRdw } from '../src/rdw';
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
