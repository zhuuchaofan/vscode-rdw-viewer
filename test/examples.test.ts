/**
 * examples/ の検証：
 *  - リポジトリ内のファイルが生成器（test/fixtures/examples.ts）の出力と一致すること
 *  - 拡張機能と同じ手順で設定（.vscode/rdw-viewer.json、settings.json）を適用して、期待どおりに表示されること
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import './helpers';
import { buildExamples, COPYBOOKS, MAPPING } from './fixtures/examples';
import { RdwSession, RecRow } from '../src/session';
import { parseCopybook } from '../src/copybook';
import { plainSegments } from '../src/autodetect';

const ROOT = path.resolve(__dirname, '../../examples');
const files = buildExamples();

test('examples/ が生成器の出力と一致する（npm run examples で再生成）', () => {
  for (const [rel, data] of Object.entries(files)) {
    const file = path.join(ROOT, rel);
    assert.ok(fs.existsSync(file), `${rel} がありません`);
    assert.ok(fs.readFileSync(file).equals(data), `${rel} が生成器の出力と異なります`);
  }
});

/** 拡張機能の applyMapping と同じ手順で設定を適用して開く */
function open(name: string): RdwSession {
  const settings = JSON.parse(files['.vscode/settings.json'].toString());
  const s = new RdwSession(files[name], name, { comp5Endian: settings['rdwViewer.comp5Endian'] });
  const cfg = JSON.parse(files['.vscode/rdw-viewer.json'].toString()) as typeof MAPPING;
  type Disc = { start: number; length: number; type: 'text' | 'comp3'; copybooks: Record<string, string> };
  const discs = cfg.discriminators as unknown as Record<string, Disc>;
  for (const len of new Set(s.groups.map((g) => g.length))) {
    const d = discs[String(len)];
    s.setDiscriminator(len, d ? { start: d.start, length: d.length, type: d.type } : null);
  }
  for (const g of [...s.groups]) {
    const key = g.value === undefined ? String(g.length) : `${g.length}=${g.value}`;
    s.setLayoutSelection(g.length, cfg.layouts[key] ?? {}, g.value);
    const stored =
      g.value === undefined
        ? (cfg.copybooks as Record<string, string>)[String(g.length)]
        : discs[String(g.length)]?.copybooks[g.value];
    if (stored) {
      const name = path.basename(stored);
      s.setCopybook(g.length, { name, copybook: parseCopybook(COPYBOOKS[name]) }, undefined, g.value);
    }
  }
  return s;
}

const rows = (s: RdwSession, key: string) => s.getRows(key, 0, s.count(key)) as RecRow[];
const col = (s: RdwSession, key: string, name: string) => s.groupByKey(key)!.columns.findIndex((c) => c.name === name);
const value = (s: RdwSession, key: string, row: number, name: string) => rows(s, key)[row].c[col(s, key, name)].trimEnd();

test('COPY句はすべて警告なしで解析でき、レコード長どおり', () => {
  const expected: Record<string, number> = {
    'CUSTOMER.cpy': 120, 'HEADER.cpy': 40, 'DETAIL.cpy': 80, 'TRAILER.cpy': 30,
    'SL-HEADER.cpy': 64, 'SL-DETAIL.cpy': 64, 'SL-TRAILER.cpy': 64, 'PAYMENT.cpy': 56, 'NUMERIC.cpy': 60,
  };
  for (const [name, len] of Object.entries(expected)) {
    const cb = parseCopybook(COPYBOOKS[name]);
    assert.deepEqual(cb.warnings, [], name);
    assert.equal(cb.totalLength, len, name);
  }
});

test('01-customer：固定形式の COPY句、日本語・半角カナ・COMP-3・ゾーン 10 進', () => {
  const s = open('01-customer.dat');
  const g = s.init().groups;
  assert.deepEqual(g.map((x) => [x.key, x.count, x.banner.level]), [['L120', 12, 'info']]);
  assert.equal(value(s, 'L120', 0, 'CUST-NAME'), '山田　太郎');
  assert.equal(value(s, 'L120', 0, 'CUST-KANA'), 'ﾔﾏﾀﾞ ﾀﾛｳ');
  assert.equal(value(s, 'L120', 0, 'CUST-BALANCE'), '+123456.78');
  assert.equal(value(s, 'L120', 3, 'CUST-BALANCE'), '-1250.50');
  assert.equal(s.cellInfo('L120', 4, col(s, 'L120', 'CUST-LIMIT'))!.value, '-30000.00');
  assert.ok(rows(s, 'L120').every((r) => r.w.length === 0), '正常データにオレンジのセルがある');
});

test('02-mixed-length：ヘッダー・明細・トレーラーのレコード長が異なる', () => {
  const s = open('02-mixed-length.dat');
  assert.deepEqual(s.init().groups.map((x) => [x.key, x.count, x.banner.level]), [
    ['L40', 1, 'info'], ['L80', 5, 'info'], ['L30', 1, 'info'],
  ]);
  assert.equal(value(s, 'L80', 0, 'ITEM-NAME'), 'ボールペン（黒）');
  assert.equal(value(s, 'L80', 0, 'AMOUNT'), '+1440.00');
  assert.equal(value(s, 'L80', 1, 'UNIT-PRICE'), '+280.50');
  assert.equal(value(s, 'L30', 0, 'TOTAL-AMOUNT'), '+10242.50'); // 1440 + 1402.5 + 2940 + 2960 + 1500
  // ファイル順ビュー：グループが切り替わるたびに見出しが入る
  assert.equal(s.count('ORDER'), 3 * 3 + 7);
});

test('03-same-length：同じレコード長をレコード区分（1 バイト目）で切り替え', () => {
  const s = open('03-same-length.dat');
  assert.deepEqual(s.init().groups.map((x) => [x.value, x.count, x.copybookName, x.banner.level]), [
    ['H', 1, 'SL-HEADER.cpy', 'info'], ['D', 4, 'SL-DETAIL.cpy', 'info'], ['T', 1, 'SL-TRAILER.cpy', 'info'],
  ]);
  assert.equal(value(s, 'L64=D', 0, 'ITEM-NAME'), '弁当'); // PIC N の全角空白埋めは trimEnd で除かれる
  assert.equal(value(s, 'L64=D', 3, 'QTY'), '+2');
  assert.equal(value(s, 'L64=T', 0, 'TOTAL-AMOUNT'), '+3760');
});

test('04-redefines：支払区分ごとに REDEFINES のレイアウトを切り替え', () => {
  const s = open('04-redefines.dat');
  const g = s.init().groups;
  assert.deepEqual(g.map((x) => [x.value, x.count, x.choices[0].selected, x.banner.level]), [
    ['C', 2, 'PAY-CARD', 'info'], ['B', 2, 'PAY-BANK', 'info'], ['K', 1, 'PAY-CASH', 'info'],
  ]);
  assert.equal(value(s, 'L56=C', 0, 'CARD-NO'), '4111111111111111');
  assert.equal(value(s, 'L56=B', 0, 'ACCOUNT-NAME'), 'ｻﾄｳ ﾊﾅｺ');
  assert.equal(value(s, 'L56=B', 1, 'BANK-CODE'), '0005');
  assert.equal(value(s, 'L56=K', 0, 'CHANGE-AMOUNT'), '+1760');
  assert.equal(value(s, 'L56=K', 0, 'PAY-AMOUNT'), '+3240.00');
  assert.ok(g.every((x) => rows(s, x.key).every((r) => r.w.length === 0)));
});

test('05-numeric：各種 USAGE。不正・疑わしいデータだけがオレンジになる', () => {
  const s = open('05-numeric.dat');
  const r = rows(s, 'L60');
  const v = (row: number, name: string) => value(s, 'L60', row, name);
  assert.deepEqual(
    ['N-PACKED', 'N-BINARY', 'N-BINARY-L', 'N-NATIVE', 'N-FLOAT', 'N-DOUBLE'].map((n) => v(1, n)),
    ['-987.65', '-987', '-98700', '+2961', '-123.4563', '-141.092857142857']
  );
  assert.equal(v(0, 'N-LEAD-SEP'), '+01234');
  assert.equal(v(0, 'N-TRAIL-SEP'), '01234+');
  assert.equal(s.cellInfo('L60', 1, col(s, 'L60', 'N-ZONED'))!.value, '-987.65');
  assert.deepEqual(r.slice(0, 3).map((x) => x.w), [[], [], []]);
  const bad = r[3].w.map((i) => s.groupByKey('L60')!.columns[i].name);
  assert.deepEqual(bad, ['N-ZONED', 'N-LEAD-SEP', 'N-PACKED', 'N-BINARY', 'N-FLOAT']);
});

test('06-broken：RDW の不一致・長さ不正・途中切れを検出して続きを表示', () => {
  const s = open('06-broken.dat');
  assert.equal(s.count('ERR'), 3);
  assert.deepEqual(s.init().groups.map((x) => [x.key, x.count]), [['L24', 4]]);
  const errs = (s.getRows('ERR', 0, 3) as import('../src/session').ErrRow[]).map((r) => r.c[2]);
  assert.match(errs[0], /前后不一致/);
  assert.match(errs[1], /重新找到记录边界/);
  assert.match(errs[2], /截断/);
});

test('07-no-copybook：COPY句なし。COMP-3 を自動判別', () => {
  const s = open('07-no-copybook.dat');
  const g = s.init().groups[0];
  assert.equal(g.copybookName, null);
  const texts = rows(s, 'L48').map((x) => plainSegments(x.c[0]));
  assert.deepEqual(texts, ['ITEM0001鉛筆　　　　　　　　[+1200][+10]', 'ITEM0002消しゴム　　　　　　[+980][+5]', 'ITEM0003定規　　　　　　　　[+2500][-1]']);
});
