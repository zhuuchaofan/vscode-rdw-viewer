import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeShiftJis } from '../src/sjisEncode';
import { hexBytes } from './helpers';

const dec = new TextDecoder('shift_jis');

test('ASCII、半角片假名、日文汉字', () => {
  assert.deepEqual(Buffer.from(encodeShiftJis('AB,1').bytes), Buffer.from('AB,1'));
  assert.deepEqual(Buffer.from(encodeShiftJis('ｱｲ').bytes), hexBytes('B1 B2'));
  assert.deepEqual(Buffer.from(encodeShiftJis('日本語テスト').bytes), hexBytes('93FA967B8CEA 836583588367'));
});

test('Shift_JIS 能解码的所有双字节字符，编码后再解码都能还原', () => {
  let checked = 0;
  for (let lead = 0x81; lead <= 0xfc; lead++) {
    if (lead > 0x9f && lead < 0xe0) continue;
    for (let trail = 0x40; trail <= 0xfc; trail++) {
      if (trail === 0x7f) continue;
      const s = dec.decode(Uint8Array.of(lead, trail));
      if (s.length !== 1 || s === '�') continue;
      const r = encodeShiftJis(s);
      assert.equal(r.unmappable, 0, `无法编码 ${s}`);
      assert.equal(dec.decode(r.bytes), s, `往返不一致：${lead.toString(16)}${trail.toString(16)}`);
      checked++;
    }
  }
  assert.ok(checked > 7000, `只检查了 ${checked} 个字符`);
});

test('JIS 与 Windows-31J 写法不同的字符、界面符号', () => {
  assert.equal(dec.decode(encodeShiftJis('〜−·—').bytes), '～－・―');
  assert.equal(encodeShiftJis('〜−·—').unmappable, 0);
});

test('无法表示的字符替换为 ? 并计数', () => {
  const r = encodeShiftJis('A😀B한');
  assert.equal(dec.decode(r.bytes), 'A?B?');
  assert.equal(r.unmappable, 2);
});
