import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodePacked, decodeBinary, decodeByUsage, formatNumber } from '../src/numeric';
import { hexBytes } from './helpers';

test('COMP-3：正负号、F 无符号、前导零', () => {
  assert.deepEqual(decodePacked(hexBytes('12 34 5C'), 0, true), { text: '+12345', ok: true });
  assert.deepEqual(decodePacked(hexBytes('12 34 5D'), 0, true), { text: '-12345', ok: true });
  assert.deepEqual(decodePacked(hexBytes('00 00 0C'), 0, true), { text: '+0', ok: true });
  assert.deepEqual(decodePacked(hexBytes('00 12 3F'), 0, false), { text: '123', ok: true });
  assert.deepEqual(decodePacked(hexBytes('0C'), 0, true), { text: '+0', ok: true });
});

test('COMP-3：小数位数（PIC S9(5)V99）', () => {
  assert.equal(decodePacked(hexBytes('12 34 56 7C'), 2, true).text, '+12345.67');
  assert.equal(decodePacked(hexBytes('00 00 05 0D'), 2, true).text, '-0.50');
  assert.equal(decodePacked(hexBytes('00 00 00 1C'), 3, true).text, '+0.001');
});

test('COMP-3：非法半字节 → ok=false', () => {
  assert.equal(decodePacked(hexBytes('12 3A 5C'), 0, true).ok, false); // 数字位 A
  assert.equal(decodePacked(hexBytes('12 34 50'), 0, true).ok, false); // 符号位 0
  assert.equal(decodePacked(hexBytes('00 00 00'), 0, true).ok, false); // 符号位 0
  assert.equal(decodePacked(new Uint8Array(0), 0, true).ok, false);
});

test('COMP-3：18 位以上不丢精度', () => {
  const r = decodePacked(hexBytes('12 34 56 78 90 12 34 56 78 9C'), 0, true);
  assert.equal(r.text, '+1234567890123456789');
});

test('COMP：大端/小端、有符号/无符号', () => {
  assert.equal(decodeBinary(hexBytes('00 7B'), 0, true, false).text, '+123');
  assert.equal(decodeBinary(hexBytes('7B 00'), 0, true, true).text, '+123');
  assert.equal(decodeBinary(hexBytes('FF FF'), 0, true, false).text, '-1');
  assert.equal(decodeBinary(hexBytes('FF FF'), 0, false, false).text, '65535');
  assert.equal(decodeBinary(hexBytes('FF FF FF FE'), 2, true, false).text, '-0.02');
  assert.equal(decodeBinary(hexBytes('7F FF FF FF FF FF FF FF'), 0, true, false).text, '+9223372036854775807');
});

test('decodeByUsage：未知 USAGE 返回 undefined；浮点', () => {
  assert.equal(decodeByUsage(hexBytes('00'), 'DISPLAY', 0, false, false), undefined);
  assert.equal(decodeByUsage(hexBytes('3F 80 00 00'), 'COMP-1', 0, true, false)!.text, '1');
});

test('formatNumber', () => {
  assert.equal(formatNumber('', 0, false, false), '0');
  assert.equal(formatNumber('5', 2, false, true), '+0.05');
});
