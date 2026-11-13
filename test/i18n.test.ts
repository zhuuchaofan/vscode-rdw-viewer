import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DICTS, setLocale, t, uiStrings, getLocale } from '../src/i18n';

test('默认语言为日语（主要界面语言）', () => {
  assert.equal(getLocale(), 'ja');
  assert.equal(t('ui.orderTab'), 'ファイル順');
});

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('中日字典：键相同、占位符一致、没有空字符串', () => {
  const zhKeys = Object.keys(DICTS.zh).sort();
  assert.deepEqual(Object.keys(DICTS.ja).sort(), zhKeys);
  for (const k of zhKeys as (keyof typeof DICTS.zh)[]) {
    assert.deepEqual(placeholders(DICTS.ja[k]), placeholders(DICTS.zh[k]), `占位符不一致：${k}`);
    assert.ok(DICTS.ja[k].length > 0 && DICTS.zh[k].length > 0, `空字符串：${k}`);
  }
});

test('按 VS Code 显示语言切换', () => {
  setLocale('ja');
  assert.equal(t('ui.orderTab'), 'ファイル順');
  assert.equal(t('ui.records', { n: 3 }), '3 件');
  assert.equal(uiStrings().orderTab, 'ファイル順');
  setLocale('zh-cn');
  assert.equal(t('ui.orderTab'), '文件顺序');
  setLocale('zh-tw');
  assert.equal(t('ui.orderTab'), '文件顺序');
  // 中文以外的语言（英语等）一律显示日语
  setLocale('en');
  assert.equal(t('ui.orderTab'), 'ファイル順');
  setLocale(undefined);
  assert.equal(getLocale(), 'ja');
});

test('package.nls：package.json 引用的键在中日文件里都存在', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require('fs');
  const pkg = fs.readFileSync(require.resolve('../../package.json'), 'utf8');
  const keys = [...pkg.matchAll(/"%([\w.]+)%"/g)].map((m: RegExpMatchArray) => m[1]);
  assert.ok(keys.length >= 5);
  // 默认（package.nls.json）为日语
  const def = JSON.parse(fs.readFileSync(require.resolve('../../package.nls.json'), 'utf8'));
  assert.equal(def['command.open'], 'RDW Viewer で開く');
  for (const f of ['package.nls.json', 'package.nls.ja.json', 'package.nls.zh-cn.json']) {
    const nls = JSON.parse(fs.readFileSync(require.resolve('../../' + f), 'utf8'));
    for (const k of keys) {
      assert.ok(nls[k], `${f} 缺少 ${k}`);
    }
  }
});

test('日语文案的用语统一', () => {
  const ja = Object.values(DICTS.ja).join('\n');
  // copybook 统一写作「COPY句」，不混用其他写法
  assert.ok(!/コピー句|コピーブック|copybook/i.test(ja.replace(/rdwViewer\.\w+/g, '')), 'copybook 的写法不统一');
  // 跳过统一写作「読み飛ばし」
  assert.ok(!/スキップ/.test(ja), '「スキップ」与「読み飛ばし」混用');
  // 不残留中文专用字
  assert.ok(!/[们这个们说没对]/.test(ja), '日语文案中残留中文');
});
