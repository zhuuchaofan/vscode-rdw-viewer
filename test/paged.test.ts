import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PagedFileSource, MemorySource } from '../src/source';
import { scanRdw, scanRdwAsync } from '../src/rdw';
import { RdwSession, RecRow } from '../src/session';
import { CompareSession } from '../src/compare';
import { parseCopybook } from '../src/copybook';
import { exportChunks } from '../src/export';
import { rec, ascii, hexBytes } from './helpers';

function withTempFiles<T>(contents: Buffer[], fn: (paths: string[]) => Promise<T> | T): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rdw-viewer-test-'));
  const paths = contents.map((buf, i) => {
    const p = path.join(dir, `f${i}.dat`);
    fs.writeFileSync(p, buf);
    return p;
  });
  return Promise.resolve()
    .then(() => fn(paths))
    .finally(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

const CPY = parseCopybook(`
  01 REC.
     05 KIND PIC X(2).
     05 ID   PIC X(6).
     05 AMT  PIC S9(5)V99 COMP-3.
     05 NOTE PIC X(8).
`); // 2 + 6 + 4 + 8 = 20

test('PagedFileSource：跨页边界随机读取、LRU 页淘汰与内存源结果完全一致', async () => {
  const raw = Buffer.alloc(10_000);
  for (let i = 0; i < raw.length; i++) {
    raw[i] = (i * 131 + 17) & 0xff;
  }
  await withTempFiles([raw], ([file]) => {
    // 故意用极小的页大小（512B）和仅 3 页缓存，强制频繁触发跨页拼接与 LRU 淘汰
    const paged = PagedFileSource.open(file, { pageSize: 512, maxPages: 3 });
    const mem = new MemorySource(raw);
    try {
      assert.equal(paged.size, raw.length);
      let seed = 42;
      const rnd = (n: number) => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % n;
      };
      for (let round = 0; round < 500; round++) {
        const off = rnd(raw.length);
        const len = rnd(2048);
        assert.deepEqual(Buffer.from(paged.read(off, len)), Buffer.from(mem.read(off, len)), `round ${round} off=${off} len=${len}`);
        assert.ok(paged.cachedPages <= 3);
      }
      // 边界情况
      assert.equal(paged.read(raw.length, 10).length, 0);
      assert.equal(paged.read(0, 0).length, 0);
      assert.equal(paged.read(-5, 10).length, 0);
    } finally {
      paged.close();
    }
    assert.equal(paged.read(0, 10).length, 0);
  });
});

test('分页大文件模式：RDW 扫描（含坏记录重同步）、判别字段分组、Hex Dump、导出与内存模式一致', async () => {
  const makeRec = (kind: string, id: number, amtHex: string, note: string) =>
    rec(Buffer.concat([ascii(kind.padEnd(2)), ascii(String(id).padStart(6, '0')), hexBytes(amtHex), ascii(note.padEnd(8))]));

  const parts: Buffer[] = [];
  for (let i = 0; i < 300; i++) {
    const kind = i % 3 === 0 ? 'HD' : i % 3 === 1 ? 'DT' : 'TR';
    parts.push(makeRec(kind, i, i % 2 === 0 ? '00 12 34 5C' : '00 05 67 8D', `N-${i}`));
    if (i === 120) {
      // 插入一条跨越页边界的损坏记录，验证分页源上的 resync 重同步
      parts.push(rec(ascii('BROKEN_PAYLOAD'), { front: 5000, back: 14 }));
    }
  }
  const buf = Buffer.concat(parts);

  await withTempFiles([buf], async ([file]) => {
    const paged = PagedFileSource.open(file, { pageSize: 512, maxPages: 4 });
    try {
      // 同步与异步扫描一致
      const idxMem = scanRdw(buf);
      const idxPaged = await scanRdwAsync(paged, { sliceMs: 0 });
      assert.ok(idxPaged);
      assert.equal(idxPaged.count, idxMem.count);
      assert.deepEqual(Array.from(idxPaged.offsets), Array.from(idxMem.offsets));
      assert.deepEqual(Array.from(idxPaged.lengths), Array.from(idxMem.lengths));
      assert.deepEqual(Array.from(idxPaged.isError), Array.from(idxMem.isError));

      const sMem = new RdwSession(buf, 'mem.dat');
      const sPag = (await RdwSession.createAsync(paged, 'mem.dat', {}, { sliceMs: 0 }))!;
      assert.ok(sPag);

      // 测试文本判别字段（走 DiscValueCache 字节哈希去重解码）
      const disc = { start: 1, length: 2, type: 'text' as const };
      assert.deepEqual(sPag.discriminatorValues(20, disc), sMem.discriminatorValues(20, disc));
      sMem.setDiscriminator(20, disc);
      sPag.setDiscriminator(20, disc);
      for (const v of ['HD', 'DT', 'TR']) {
        sMem.setCopybook(20, { name: 'r.cpy', copybook: CPY }, undefined, v);
        sPag.setCopybook(20, { name: 'r.cpy', copybook: CPY }, undefined, v);
      }

      assert.deepEqual(sPag.init(), sMem.init());
      for (const view of ['L20=HD', 'L20=DT', 'L20=TR', 'ERR', 'ORDER']) {
        assert.deepEqual(sPag.getRows(view, 0, 500), sMem.getRows(view, 0, 500), `view ${view}`);
      }

      // 验证跨页记录的 cellInfo 和 recordDump（前后 RDW 不会被共享 scratch 覆盖）
      for (const e of [0, 50, 121, 122, 250]) {
        assert.deepEqual(sPag.recordDump(e), sMem.recordDump(e), `dump entry ${e}`);
      }
      assert.deepEqual(sPag.cellInfo('L20=HD', 0, 2), sMem.cellInfo('L20=HD', 0, 2));

      // 验证导出流
      const expMem = [...exportChunks(sMem, 'L20=DT', { format: 'csv', header: true, meta: true, position: true }, 40)].map((c) => c.text).join('');
      const expPag = [...exportChunks(sPag, 'L20=DT', { format: 'csv', header: true, meta: true, position: true }, 40)].map((c) => c.text).join('');
      assert.equal(expPag, expMem);
    } finally {
      paged.close();
    }
  });
});

test('scanRdwAsync：中途取消时返回 undefined', async () => {
  const buf = Buffer.concat(Array.from({ length: 40_000 }, (_, i) => rec(ascii(String(i).padStart(8, '0')))));
  let checks = 0;
  const cancelled = await scanRdwAsync(buf, {
    sliceMs: 0,
    isCancelled: () => ++checks >= 1,
  });
  assert.equal(cancelled, undefined);
  assert.ok(checks >= 1);
});

test('分页大文件模式下的双文件比较：按序号与按复合键配对均与内存模式一致', async () => {
  const build = (ids: number[], mutate: (id: number) => string) =>
    Buffer.concat(
      ids.map((id) =>
        rec(Buffer.concat([ascii('DT'), ascii(String(id).padStart(6, '0')), hexBytes('00 00 10 0C'), ascii(mutate(id).padEnd(8))]))
      )
    );
  const idsA = Array.from({ length: 180 }, (_, i) => i);
  // B 打乱顺序、删掉一部分、新增一部分、修改一部分内容，且包含重复键
  const idsB = [200, ...idsA.filter((i) => i % 7 !== 0).reverse(), 10, 201];
  const bufA = build([...idsA, 10], (id) => `VAL-${id}`);
  const bufB = build(idsB, (id) => (id % 5 === 0 ? `CHG-${id}` : `VAL-${id}`));

  await withTempFiles([bufA, bufB], async ([pathA, pathB]) => {
    const srcA = PagedFileSource.open(pathA, { pageSize: 512, maxPages: 3 });
    const srcB = PagedFileSource.open(pathB, { pageSize: 512, maxPages: 3 });
    try {
      const memA = new RdwSession(bufA, 'a.dat');
      const memB = new RdwSession(bufB, 'b.dat');
      const pagA = new RdwSession(srcA, 'a.dat');
      const pagB = new RdwSession(srcB, 'b.dat');
      for (const s of [memA, memB, pagA, pagB]) {
        s.setCopybook(20, { name: 'r.cpy', copybook: CPY });
      }

      // 1) 按序号比较（分页 vs 内存，以及 分页 vs 内存混合）
      const cmpMemIdx = new CompareSession(memA, memB);
      const cmpPagIdx = new CompareSession(pagA, pagB);
      const cmpMixIdx = new CompareSession(pagA, memB);
      assert.deepEqual(cmpPagIdx.getStats(), cmpMemIdx.getStats());
      assert.deepEqual(cmpMixIdx.getStats(), cmpMemIdx.getStats());
      assert.deepEqual(cmpPagIdx.getRows(false, 0, 300), cmpMemIdx.getRows(false, 0, 300));

      // 2) 按复合键比较（KIND + ID）
      const keys = [
        { start: 1, length: 2 },
        { start: 3, length: 6 },
      ];
      cmpMemIdx.configure('key', keys);
      await cmpPagIdx.configureAsync('key', keys, { sliceMs: 0 });
      await cmpMixIdx.configureAsync('key', keys, { sliceMs: 0 });
      const cmpMixRev = new CompareSession(memA, pagB, false);
      await cmpMixRev.configureAsync('key', keys, { sliceMs: 0 });

      assert.deepEqual(cmpPagIdx.getStats(), cmpMemIdx.getStats());
      assert.deepEqual(cmpMixIdx.getStats(), cmpMemIdx.getStats());
      assert.deepEqual(cmpMixRev.getStats(), cmpMemIdx.getStats());
      assert.deepEqual(cmpPagIdx.getRows(false, 0, 300), cmpMemIdx.getRows(false, 0, 300));
      assert.deepEqual(cmpPagIdx.getRows(true, 0, 300), cmpMemIdx.getRows(true, 0, 300));
      assert.deepEqual(cmpPagIdx.dumpPair(5), cmpMemIdx.dumpPair(5));
      assert.deepEqual(cmpPagIdx.cellPair(5, 'a', 3), cmpMemIdx.cellPair(5, 'a', 3));
    } finally {
      srcA.close();
      srcB.close();
    }
  });
});

test('package.json：已注册 rdwViewer.editor 只读自定义编辑器（priority=option）', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));
  const editors = pkg.contributes?.customEditors;
  assert.ok(Array.isArray(editors) && editors.length === 1);
  assert.equal(editors[0].viewType, 'rdwViewer.editor');
  assert.equal(editors[0].priority, 'option');
  assert.ok((editors[0].selector?.[0]?.filenamePattern as string).includes('dat'));
});
