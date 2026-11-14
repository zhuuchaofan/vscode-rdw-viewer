import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { matchesMember, memberFileNames, pickMember } from '../src/copyresolve';

test('原文名与文件名：不区分大小写，可以没有扩展名或带常见扩展名', () => {
  assert.ok(matchesMember('/w/lib/CUST.cpy', 'cust'));
  assert.ok(matchesMember('/w/lib/cust', 'CUST'));
  assert.ok(matchesMember('/w/lib/Cust.COB', 'CUST'));
  assert.ok(!matchesMember('/w/lib/CUSTOMER.cpy', 'CUST'));
  assert.ok(!matchesMember('/w/lib/CUST.txt', 'CUST'));
  assert.ok(memberFileNames('Cust').includes('CUST.CPY'));
  assert.ok(memberFileNames('Cust').includes('cust.cpy'));
  assert.ok(memberFileNames('Cust').includes('Cust'));
});

test('优先顺序：同一目录 → 目录名与登録集名一致 → 路径短的', () => {
  const base = path.join('/w', 'cpy');
  const files = [path.join('/w', 'z', 'deep', 'CUST.cpy'), path.join('/w', 'MYLIB', 'CUST.cpy'), path.join('/w', 'cpy', 'cust.cbl')];
  assert.deepEqual(pickMember('CUST', undefined, files, base), {
    chosen: files[2],
    others: [files[1], files[0]],
  });
  assert.equal(pickMember('CUST', 'mylib', files.slice(0, 2), base)!.chosen, files[1]);
  assert.equal(pickMember('CUST', undefined, files.slice(0, 2), base)!.chosen, files[1]); // 路径短的
  assert.equal(pickMember('NONE', undefined, files, base), undefined);
});
