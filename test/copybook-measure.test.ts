import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { parseCopybook, measureCopybook, isCobolProgram } from '../src/copybook';
import { measureLayout } from '../src/cobol/emit';
import { Node } from '../src/cobol/statement';

function assertMeasureMatchesBuild(label: string, text: string): void {
  const cb = parseCopybook(text);
  assert.equal(measureCopybook(text), cb.totalLength, `${label}: measureCopybook !== parseCopybook.totalLength`);
  for (const rec of cb.records) {
    const m = measureLayout(rec.root as Node);
    assert.equal(m.hasFields, true, `${label} (${rec.name}): expected hasFields=true`);
    assert.equal(m.totalLength, rec.totalLength, `${label} (${rec.name}): measureLayout !== buildLayout`);
  }
}

test('仓库 examples/copybooks 下所有 copybook 的测量长度与 buildLayout 逐字节一致', () => {
  const dir = path.resolve(__dirname, '../../examples/copybooks');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.cpy')).sort();
  assert.ok(files.length > 0);
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    assertMeasureMatchesBuild(f, text);
  }
});

test('大 OCCURS、多层嵌套 OCCURS、ODO 的测量长度与 buildLayout 一致', () => {
  assertMeasureMatchesBuild(
    'large-occurs',
    `
      01 LARGE-REC.
         05 HDR PIC X(10).
         05 ROW-T OCCURS 5000 TIMES.
            10 F1 PIC X(8).
            10 F2 PIC S9(9) COMP-3.
            10 F3 PIC 9(4) COMP.
    `
  );

  assertMeasureMatchesBuild(
    'nested-3d-occurs',
    `
      01 CUBE-REC.
         05 Y OCCURS 10 TIMES.
            10 M OCCURS 12 TIMES.
               15 D OCCURS 31 TIMES.
                  20 CODE PIC X(4).
                  20 AMT PIC S9(7)V99 COMP-3.
    `
  );

  assertMeasureMatchesBuild(
    'odo-tail-and-mid',
    `
      01 ODO-REC.
         05 CNT PIC 9(4) COMP.
         05 MID-T OCCURS 1 TO 50 DEPENDING ON CNT.
            10 A PIC X(6).
            10 B PIC S9(5) COMP-3.
         05 TAIL-F PIC X(3).
    `
  );
});

test('超大嵌套 OCCURS 仅测量长度时不展开 CopyField 且返回正确总长度', () => {
  const huge = `
    01 HUGE-CUBE.
       05 D1 OCCURS 1000 TIMES.
          10 D2 OCCURS 1000 TIMES.
             15 D3 OCCURS 20 TIMES.
                20 F1 PIC X(4).
                20 F2 PIC S9(7) COMP-3.
  `;
  // (4 + 4) * 20 * 1000 * 1000 = 160,000,000
  assert.equal(measureCopybook(huge), 160_000_000);
});

test('REDEFINES（含 OCCURS 内部、未选分支更长、未选分支含 layout/ODO 问题）测量一致且问题照常上报', () => {
  const redefInOccurs = `
    01 REDEF-REC.
       05 GRP OCCURS 20 TIMES.
          10 BASE.
             15 A1 PIC X(4).
             15 A2 PIC 9(4).
          10 ALT-LONGER REDEFINES BASE.
             15 B1 PIC X(12).
          10 ALT-SHORT REDEFINES BASE.
             15 C1 PIC X(2).
       05 END-F PIC X(3).
  `;
  assertMeasureMatchesBuild('redef-in-occurs', redefInOccurs);

  const hiddenIssues = `
    01 REDEF-ISSUE-REC.
       05 HEAD PIC X(4).
       05 BASE PIC X(10).
       05 ALT-ODO REDEFINES BASE.
          10 CNT PIC 9(2).
          10 ARR OCCURS 1 TO 5000 DEPENDING ON CNT PIC X(2).
       05 TAIL PIC X(2).
  `;
  assertMeasureMatchesBuild('redef-hidden-odo', hiddenIssues);
  const cb = parseCopybook(hiddenIssues);
  assert.equal(cb.totalLength, 4 + (2 + 10000) + 2);
  assert.equal(cb.records[0].trust, 'untrusted');
  assert.equal(cb.fields[0].suspect, undefined);
  assert.equal(cb.fields[1].suspect, true);
  assert.equal(cb.fields[2].suspect, true);
});

test('无 01 层片段（多 05、先 10 后 05、含 REDEFINES 与 OCCURS）测量长度与 buildLayout 一致', () => {
  assertMeasureMatchesBuild(
    'no01-siblings',
    `
      05 A PIC X(3).
      05 B PIC 9(4).
      05 C OCCURS 10 TIMES.
         10 D PIC X(2).
         10 E PIC S9(5) COMP-3.
    `
  );

  assertMeasureMatchesBuild(
    'no01-10-then-05-redef',
    `
      10 FIRST-F PIC X(2).
      05 SECOND-A PIC X(6).
      05 SECOND-B REDEFINES SECOND-A.
         10 S1 PIC X(4).
         10 S2 PIC X(5).
      05 TAIL PIC X(1).
    `
  );
});

test('SYNC（前置填充、组内填充、OCCURS repAlign 补齐、嵌套 OCCURS SYNC）测量长度与 buildLayout 一致', () => {
  assertMeasureMatchesBuild(
    'sync-occurs-repalign',
    `
      01 SYNC-REC.
         05 FLAG PIC X(1).
         05 ITEM OCCURS 7 TIMES.
            10 TAG PIC X(1).
            10 VAL PIC S9(9) COMP SYNC.
            10 SUFFIX PIC X(1).
         05 BIG OCCURS 3 TIMES.
            10 B1 PIC X(1).
            10 DBL USAGE COMP-2 SYNC.
            10 B2 PIC X(3).
    `
  );

  assertMeasureMatchesBuild(
    'sync-nested-occurs',
    `
      01 SYNC-NESTED.
         05 PFX PIC X(1).
         05 OUTER OCCURS 4 TIMES.
            10 INNER OCCURS 5 TIMES.
               15 K PIC X(1).
               15 N PIC S9(4) COMP SYNC.
               15 M PIC S9(9) COMP SYNC.
    `
  );
});

test('USAGE BIT（连续位打包、OCCURS、ALIGNED、与普通字段混排）测量长度与 buildLayout 一致', () => {
  assertMeasureMatchesBuild(
    'usage-bit',
    `
      01 BIT-REC.
         05 B1 PIC 1(3) USAGE BIT.
         05 B2 PIC 1(1) USAGE BIT OCCURS 10 TIMES.
         05 B3 PIC 1(2) USAGE BIT ALIGNED.
         05 B4 PIC 1(5) USAGE BIT.
         05 NEXT-F PIC X(4).
         05 GRP OCCURS 3 TIMES.
            10 GB PIC 1(1) USAGE BIT OCCURS 9 TIMES.
            10 GX PIC X(1).
    `
  );
});

test('完整 COBOL 程序识别与测量长度一致；注释与字面量中的 DIVISION 不误判', () => {
  const prog = `
       IDENTIFICATION DIVISION.
       PROGRAM-ID. SAMPLE01.
       DATA DIVISION.
       FILE SECTION.
       01 IN-REC.
          05 IN-KEY PIC X(10).
          05 IN-VAL PIC 9(6).
       WORKING-STORAGE SECTION.
       01 WS-TBL.
          05 WS-ROW OCCURS 50 TIMES.
             10 W1 PIC X(4).
       PROCEDURE DIVISION.
           STOP RUN.
  `;
  assert.equal(isCobolProgram(prog), true);
  assertMeasureMatchesBuild('full-cobol-prog', prog);

  const procOnly = `
       01 REC.
          05 A PIC X(4).
       PROCEDURE DIVISION USING REC.
           GOBACK.
  `;
  assert.equal(isCobolProgram(procOnly), true);

  const copyWithCommentAndLiteral = `
      * THIS COPYBOOK IS INCLUDED IN PROCEDURE DIVISION
       01 MSG-REC.
          05 LABEL PIC X(20) VALUE 'PROCEDURE DIVISION'.
          05 LABEL2 PIC X(25) VALUE 'IDENTIFICATION DIVISION'.
  `;
  assert.equal(isCobolProgram(copyWithCommentAndLiteral), false);
  assertMeasureMatchesBuild('copy-with-division-text', copyWithCommentAndLiteral);
});
