import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentBody, formatSegments, plainSegments } from '../src/autodetect';
import { ascii, hexBytes } from './helpers';

const sjis = new TextDecoder('shift_jis');
const show = (bytes: Buffer) => plainSegments(formatSegments(bytes, segmentBody(bytes), sjis));

test('截图中的真实记录：COMP-3 与文字正确切分', () => {
  const body = Buffer.concat([
    hexBytes('11 80 0C'),
    ascii('1FVAO-M006'),
    hexBytes('00 00 00 0C'),
    hexBytes('00 00 00 0C'),
    hexBytes('22 50 93 0C'),
    hexBytes('22 51 00 6C'),
    ascii('     '),
  ]);
  assert.equal(show(body), '[+11800]1FVAO-M006[+0][+0][+2250930][+2251006]     ');
});

test('1600 字节记录开头：多个相邻 COMP-3', () => {
  // レコードID S9(5) / データ種別 9(1) / KEY科目コード S9(2) / KEY金庫番号 S9(2) / KEY店番号 S9(3) / KEY会員番号 S9(5)
  const body = Buffer.concat([
    hexBytes('11 85 0C'),
    ascii('2'),
    hexBytes('04 8C'),
    hexBytes('00 1C'),
    hexBytes('01 2C'),
    hexBytes('90 00 0C'),
  ]);
  assert.equal(show(body), '[+11850]2[+48][+1][+12][+90000]');
});

test('文字末尾的数字不会被吞进 COMP-3', () => {
  const body = Buffer.concat([ascii('ABC-M006'), hexBytes('00 00 12 3C'), ascii('XYZ')]);
  assert.equal(show(body), 'ABC-M006[+123]XYZ');
});

test('SJIS 日文文字、半角片假名保持为文字', () => {
  const body = Buffer.concat([hexBytes('93FA967B8CEA'), ascii('  '), hexBytes('B1 B2'), hexBytes('12 3D')]);
  assert.equal(show(body), '日本語  ｱｲ[-123]');
});

test('无符号 COMP-3（F）不带符号；无法识别的字节显示为十六进制', () => {
  const body = Buffer.concat([ascii('AB'), hexBytes('01 23 4F'), hexBytes('00 00 00'), ascii('CD')]);
  assert.equal(show(body), 'AB[1234]‹00 00 00›CD');
});

test('全空格、空正文', () => {
  assert.equal(show(Buffer.from('      ')), '      ');
  assert.equal(show(Buffer.alloc(0)), '');
});

test('截图中 1600 字节记录：KEY顧客番号 S9(8) 等连续 COMP-3', () => {
  const body = Buffer.concat([
    hexBytes('11 85 0C'), ascii('2'), hexBytes('04 8C'), hexBytes('00 1C'), hexBytes('01 2C'),
    hexBytes('90 10 0C'), hexBytes('00 0C'), hexBytes('01 30 14 45 4C'),
  ]);
  assert.equal(show(body), '[+11850]2[+48][+1][+12][+90100][+0][+13014454]');
});

test('COMP-3 以 0x20 开头：紧跟在另一个 COMP-3 后时识别为数值；紧跟文字时视为文字末尾的空格', () => {
  const afterPacked = Buffer.concat([hexBytes('00 1C'), hexBytes('20 25 11 3C'), ascii('END')]);
  assert.equal(show(afterPacked), '[+1][+2025113]END');
  // 歧义：定长文字字段末尾补空格很常见，因此判为文字（已知限制）
  const afterText = Buffer.concat([ascii('ID01'), hexBytes('20 25 11 3C')]);
  assert.equal(show(afterText), 'ID01 [+25113]');
});
