/**
 * P1：不同平台 / 编译器的数值存储格式。重点是「错误数据不能显示为正常值」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeNumeric, decodeZoned, decodeIbmFloat, NumericField, NumericOptions, DEFAULT_NUMERIC_OPTIONS } from '../src/numeric';
import { hexBytes } from './helpers';

const f = (usage: string, digits: number, signed = true, scale = 0): NumericField => ({ usage, digits, signed, scale });
const dec = (hex: string, field: NumericField, opts: Partial<NumericOptions> = {}) =>
  decodeNumeric(hexBytes(hex), field, { ...DEFAULT_NUMERIC_OPTIONS, ...opts })!;

test('COMP-3：位数溢出、无符号项目带负号 → 可疑；非法半字节 → 非法', () => {
  assert.deepEqual(dec('01 23 4C', f('COMP-3', 4)), { text: '+1234', ok: true, suspect: false });
  // S9(4) 占 3 字节（可放 5 位），最高位必须为 0
  assert.deepEqual(dec('12 34 5C', f('COMP-3', 4)), { text: '+12345', ok: true, suspect: true });
  // 奇数位时没有填充半字节
  assert.equal(dec('12 34 5C', f('COMP-3', 5)).suspect, false);
  // 无符号项目：F / C 正常，D 可疑
  assert.equal(dec('12 3F', f('COMP-3', 3, false)).suspect, false);
  assert.equal(dec('12 3C', f('COMP-3', 3, false)).suspect, false);
  assert.equal(dec('12 3D', f('COMP-3', 3, false)).suspect, true);
  assert.equal(dec('12 3A 5C', f('COMP-3', 5)).ok, false);
  assert.equal(dec('12 34 51', f('COMP-3', 5)).ok, false);
});

test('COMP / BINARY：超出 PIC 位数 → 可疑；COMP-5 可用整个二进制范围', () => {
  assert.deepEqual(dec('27 0F', f('COMP', 4)), { text: '+9999', ok: true, suspect: false });
  assert.deepEqual(dec('30 39', f('COMP', 4)), { text: '+12345', ok: true, suspect: true }); // TRUNC(STD) 下不应出现
  assert.equal(dec('30 39', f('BINARY', 4)).suspect, true);
  assert.deepEqual(dec('30 39', f('COMP-5', 4)), { text: '+12345', ok: true });
  assert.equal(dec('FF FF', f('COMP', 4)).text, '-1');
  assert.equal(dec('FF FF', f('COMP', 4, false)).text, '65535'); // 无符号
  assert.equal(dec('FF FF', f('COMP', 4, false)).suspect, true);
});

test('字节序：COMP 与 COMP-5 分别设置（大型机 / 富士通为大端，x86 本地格式为小端）', () => {
  assert.equal(dec('00 00 30 39', f('COMP', 9)).text, '+12345');
  assert.equal(dec('39 30 00 00', f('COMP', 9), { binaryLittleEndian: true }).text, '+12345');
  // COMP 大端、COMP-5 小端的组合
  const mixed = { binaryLittleEndian: false, comp5LittleEndian: true };
  assert.equal(dec('00 00 30 39', f('COMP', 9), mixed).text, '+12345');
  assert.equal(dec('39 30 00 00', f('COMP-5', 9), mixed).text, '+12345');
  assert.equal(dec('FE FF FF FF FF FF FF FF', f('COMP-5', 18), mixed).text, '-2');
});

test('COMP-1 / COMP-2：IEEE（大端 / 小端）与 IBM 十六进制浮点', () => {
  const be = (n: number, size: 4 | 8) => {
    const b = Buffer.alloc(size);
    size === 4 ? b.writeFloatBE(n) : b.writeDoubleBE(n);
    return b.toString('hex');
  };
  assert.equal(dec(be(0.1, 4), f('COMP-1', 0)).text, '0.1'); // 7 位有效数字，不显示 0.10000000149…
  assert.equal(dec(be(-1234.5678, 8), f('COMP-2', 0)).text, '-1234.5678');
  assert.equal(dec('00 00 80 3F', f('COMP-1', 0), { comp5LittleEndian: true }).text, '1');
  // IBM 十六进制浮点
  assert.equal(dec('41 10 00 00', f('COMP-1', 0), { floatFormat: 'ibm' }).text, '1');
  assert.equal(dec('C2 76 A0 00', f('COMP-1', 0), { floatFormat: 'ibm' }).text, '-118.625');
  assert.equal(dec('41 10 00 00 00 00 00 00', f('COMP-2', 0), { floatFormat: 'ibm' }).text, '1');
  assert.equal(dec('40 19 99 99 99 99 99 9A', f('COMP-2', 0), { floatFormat: 'ibm' }).text, '0.1');
  assert.equal(decodeIbmFloat(hexBytes('00 00 00 00')), 0);
  // 同样的字节按 IEEE 解码会得到完全不同的值：格式设置很重要
  assert.notEqual(dec('41 10 00 00', f('COMP-1', 0)).text, '1');
  // NaN / 无穷大 → 非法
  assert.equal(dec('7F C0 00 00', f('COMP-1', 0)).ok, false);
  assert.equal(dec('7F F0 00 00 00 00 00 00', f('COMP-2', 0)).ok, false);
  assert.equal(dec('00 00 80', f('COMP-1', 0)).ok, false); // 长度不对
});

const zoned = (text: string, field: Partial<NumericField> & { signed: boolean }) =>
  decodeZoned(Buffer.from(text, 'latin1'), { usage: 'DISPLAY', scale: 0, digits: text.length, ...field });

test('外部十进制：无符号、小数位；空格、小数点等 → 非法', () => {
  assert.deepEqual(zoned('00123', { signed: false, scale: 2 }), { text: '1.23', ok: true });
  assert.equal(zoned('  123', { signed: false }).ok, false);
  assert.equal(zoned('12 34', { signed: false }).ok, false);
  assert.equal(zoned('01.23', { signed: false }).ok, false);
  assert.equal(zoned('     ', { signed: false }).ok, false);
  assert.equal(zoned('-0123', { signed: false }).ok, false); // 无符号项目不能有符号
});

test('外部十进制：符号嵌入（NetCOBOL：高 4 位 4=正、5=负）', () => {
  const s4 = { usage: 'DISPLAY', scale: 0, digits: 4, signed: true };
  // COBOL 文法書 5.4.15 USAGE 句「数字項目の内部表現」的例子
  assert.equal(decodeZoned(hexBytes('36 37 38 39'), { ...s4, signed: false }).text, '6789');
  assert.equal(decodeZoned(hexBytes('36 37 38 49'), s4).text, '+6789');
  assert.equal(decodeZoned(hexBytes('36 37 38 59'), s4).text, '-6789');
  assert.equal(decodeZoned(hexBytes('46 37 38 39'), { ...s4, signLeading: true }).text, '+6789');
  assert.equal(decodeZoned(hexBytes('56 37 38 39'), { ...s4, signLeading: true }).text, '-6789');
  // 末位为 0~9 的每个数字
  for (let d = 0; d <= 9; d++) {
    assert.equal(decodeZoned(Uint8Array.from([0x31, 0x40 + d]), s4).text, `+1${d}`);
    assert.equal(decodeZoned(Uint8Array.from([0x31, 0x50 + d]), s4).text, `-1${d}`);
  }
  assert.equal(zoned('00123', { signed: true }).text, '+123'); // 区位 3 也按正数接受
  assert.equal(zoned('0012C', { signed: true }).text, '+123');
  assert.equal(zoned('0012S', { signed: true }).text, '-123');
  assert.equal(zoned('0012@', { signed: true }).text, '+120');
  assert.equal(zoned('0012P', { signed: true }).text, '-120');
  assert.equal(zoned('12345', { signed: true, scale: 2 }).text, '+123.45');
  assert.equal(zoned('0S123', { signed: true }).ok, false); // 符号只能在末位
  assert.equal(zoned('0012S', { signed: true, signLeading: true }).ok, false); // LEADING：只能在首位
  assert.equal(zoned('0012S', { signed: false }).ok, false); // 无符号项目不能有符号
  assert.equal(zoned('0012J', { signed: true }).ok, false); // 0x4A~0x4F、0x5A~0x5F 非法
  assert.equal(zoned('0012Z', { signed: true }).ok, false);
});

test('外部十进制：其他编译器的符号写法视为非法', () => {
  assert.equal(zoned('0012s', { signed: true }).ok, false); // 0x73（p~y）
  assert.equal(zoned('0012{', { signed: true }).ok, false);
  assert.equal(zoned('0012}', { signed: true }).ok, false);
});

test('外部十进制：SIGN SEPARATE（LEADING / TRAILING）', () => {
  assert.equal(zoned('-00123', { signed: true, signSeparate: true, signLeading: true }).text, '-123');
  assert.equal(zoned('+00123', { signed: true, signSeparate: true, signLeading: true }).text, '+123');
  assert.equal(zoned('00123-', { signed: true, signSeparate: true }).text, '-123');
  assert.equal(zoned('000123', { signed: true, signSeparate: true }).ok, false); // 缺少符号
  assert.equal(zoned('00123-', { signed: true, signSeparate: true, signLeading: true }).ok, false); // 位置错误
  assert.equal(zoned('-0012S', { signed: true, signSeparate: true, signLeading: true }).ok, false); // 分离符号时不允许嵌入
});
