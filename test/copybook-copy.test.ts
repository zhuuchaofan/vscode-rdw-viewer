/**
 * COPY 的展开（NetCOBOL 文法書 7.1）：查找登録集原文、REPLACING、DISJOINING … JOINING、嵌套、循环引用。
 * 文件的查找由扩展负责，这里用内存中的表代替。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCopybook, copyReferences, CopyMember } from '../src/copybook';

const lib = (members: Record<string, string>, others: Record<string, string[]> = {}) => (name: string): CopyMember | undefined => {
  const text = members[name.toUpperCase()];
  return text === undefined ? undefined : { text, source: `${name}.cpy`, others: others[name.toUpperCase()] };
};
const fields = (src: string, members: Record<string, string>, others: Record<string, string[]> = {}) => {
  const cb = parseCopybook(src, { resolve: lib(members, others) });
  return { cb, trust: cb.records[0]?.trust, fields: cb.fields.map((f) => [f.name, f.offset, f.length]) };
};

test('记录中途的 COPY：展开后后面的字段位置正确，布局可信', () => {
  const r = fields(
    `
    01 CUSTOMER-REC.
       05 CUSTOMER-ID PIC X(10).
       COPY CUSTDTL.
       05 CUSTOMER-STATUS PIC X(1).
  `,
    { CUSTDTL: '05 D1 PIC X(60).\n05 D2 PIC X(40).' }
  );
  assert.deepEqual(r.fields, [['CUSTOMER-ID', 0, 10], ['D1', 10, 60], ['D2', 70, 40], ['CUSTOMER-STATUS', 110, 1]]);
  assert.equal(r.trust, 'ok');
  assert.ok(r.cb.warnings.some((w) => w.includes('CUSTDTL') && w.includes('CUSTDTL.cpy')), '提示展开了哪个文件');
});

test('登録集原文是固定格式（带序号、73~80 列标识），主 copybook 是自由格式', () => {
  const fixed = ['000100     05  D1  PIC X(3).'.padEnd(72) + 'MEMBER01', '000200     05  D2  PIC 9(2).'.padEnd(72) + 'MEMBER01'].join('\n');
  const r = fields('01 R. 05 A PIC X. COPY M. 05 Z PIC X.', { M: fixed });
  assert.deepEqual(r.fields, [['A', 0, 1], ['D1', 1, 3], ['D2', 4, 2], ['Z', 6, 1]]);
});

test('COPY 原文名写成字面量；OF / IN 登録集名', () => {
  const m = { 'CUST.CPY': '05 D PIC X(4).', M: '05 E PIC X(2).' };
  assert.deepEqual(fields(`01 R. COPY 'cust.cpy'. COPY M OF MYLIB.`, m).fields, [['D', 0, 4], ['E', 4, 2]]);
});

test('REPLACING：伪文本、词、字面量；整个原文语一致时才替换', () => {
  const r = fields(
    `01 R. COPY M REPLACING ==LEN== BY ==10== FOO BY BAR ==PIC X(3)== BY ==PIC 9(3)== 'A' BY 'B'.`,
    { M: `05 FOO PIC X(LEN).\n05 FOO-2 PIC X(3) VALUE 'A'.\n05 X PIC X(3).` }
  );
  // FOO-2 是另一个原文语，不会被 FOO 替换
  assert.deepEqual(r.fields, [['BAR', 0, 10], ['FOO-2', 10, 3], ['X', 13, 3]]);
  assert.deepEqual(r.cb.fields.map((f) => f.pic), ['X(10)', '9(3)', '9(3)']);
});

test('DISJOINING … JOINING … AS PREFIX / SUFFIX：替换原文语的前缀 / 后缀', () => {
  const m = { M: '05 AAA-NAME PIC X(5).\n05 AAA-CODE REDEFINES AAA-NAME PIC X(2).\n05 NAME-OLD PIC X.' };
  const p = fields('01 R. COPY M DISJOINING AAA JOINING BBB AS PREFIX.', m);
  assert.deepEqual(p.fields.map((f) => f[0]), ['BBB-NAME', 'NAME-OLD']);
  assert.deepEqual(p.cb.records[0].sets.map((x) => x.options), [['BBB-NAME', 'BBB-CODE']]);
  const s = fields('01 R. COPY M DISJOINING OLD JOINING NEW AS SUFFIX.', m);
  assert.deepEqual(s.fields.map((f) => f[0]), ['AAA-NAME', 'NAME-NEW']);
});

test('嵌套的 COPY；循环引用时不展开并标为不可信', () => {
  const nested = fields('01 R. COPY A. 05 Z PIC X.', { A: '05 A1 PIC X(2). COPY B.', B: '05 B1 PIC X(3).' });
  assert.deepEqual(nested.fields, [['A1', 0, 2], ['B1', 2, 3], ['Z', 5, 1]]);

  const cyc = fields('01 R. COPY A. 05 Z PIC X.', { A: '05 A1 PIC X(2). COPY B.', B: 'COPY A.' });
  assert.equal(cyc.trust, 'untrusted');
  assert.deepEqual(cyc.cb.fields.filter((f) => f.suspect).map((f) => f.name), ['Z']);
});

test('找不到登録集原文：不可信，COPY 之后的字段可疑', () => {
  const r = fields('01 R. 05 A PIC X. COPY NOPE. 05 Z PIC X.', {});
  assert.equal(r.trust, 'untrusted');
  assert.deepEqual(r.cb.fields.filter((f) => f.suspect).map((f) => f.name), ['Z']);
  assert.ok(r.cb.warnings.some((w) => w.includes('NOPE')));
});

test('有多个同名文件：使用其中一个并提示（部分支持）', () => {
  const r = fields('01 R. COPY M.', { M: '05 D PIC X.' }, { M: ['other/M.cpy'] });
  assert.equal(r.trust, 'partial');
  assert.ok(r.cb.warnings.some((w) => w.includes('other/M.cpy')));
});

test('XMDLIB / XFDLIB（画面、帐票定义）和无法解析的 COPY：不展开，不可信', () => {
  assert.equal(fields('01 R. 05 A PIC X. COPY SCR OF XMDLIB. 05 Z PIC X.', { SCR: '05 S PIC X.' }).trust, 'untrusted');
  assert.equal(fields('01 R. 05 A PIC X. COPY M REPLACING ==A==. 05 Z PIC X.', { M: '05 S PIC X.' }).trust, 'untrusted');
});

test('记录之外的 COPY：登録集原文中的 01 记录也会显示', () => {
  const cb = parseCopybook('COPY HDR. 01 DATA-REC. 05 D PIC X(5).', { resolve: lib({ HDR: '01 HDR-REC. 05 H PIC X(3).' }) });
  assert.deepEqual(cb.records.map((r) => [r.name, r.totalLength, r.trust]), [['HDR-REC', 3, 'ok'], ['DATA-REC', 5, 'ok']]);
});

test('copyReferences：列出需要事先读取的原文名（不含画面 / 帐票定义）', () => {
  assert.deepEqual(copyReferences(`01 R. COPY A. COPY 'b.cpy' OF LIB1 REPLACING ==X== BY ==Y==. COPY S OF XMDLIB.`), [
    { name: 'A', library: undefined },
    { name: 'b.cpy', library: 'LIB1' },
  ]);
});
