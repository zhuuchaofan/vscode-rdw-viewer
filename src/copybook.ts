/**
 * 简易 COBOL copybook 解析器：把 copybook 展开成「叶子字段」列表（名称、偏移、长度、类型）。
 *
 * 支持：
 *  - 固定格式（第 7 列注释 / 续行，第 8~72 列）、可变格式（第 8 列到行尾）和自由格式
 *  - 固定 / 可变格式的续行（第 7 列为 -）：词、PIC 字符串、文字字面量
 *  - 层级号 01~49、77，FILLER，GROUP
 *  - PIC X/A/9/S/V/Z/N/G 等及 (n) 重复
 *  - USAGE DISPLAY / COMP / COMP-3 / COMP-5 / COMP-1 / COMP-2 / BINARY-CHAR 等；组项目的 USAGE、SIGN、SYNC 由下级项目继承
 *  - SIGN [LEADING|TRAILING] SEPARATE（符号占 1 字节）
 *  - OCCURS n（展开为 name(1)、嵌套时 name(1,2)…）
 *  - REDEFINES：原项目与重定义项目共用同一区域（大小取最大者），可切换显示哪一个布局
 *  - 多个 01：按记录长度选用；同长度的多个 01 也可切换；01 TYPEDEF 不作为记录
 *
 * 不支持的写法不会静默跳过，而是作为「问题」报告（CopyIssue），并区分影响程度：
 *  - layout：可能改变字段的位置或长度（未展开的 COPY、SYNC 需要的填充、OCCURS DEPENDING ON 之后的字段、
 *            无法识别的子句等）。该位置之后的字段标为「可疑」，整个布局标为不可信。
 *  - value：位置可靠，但数值的解释可能不对（PIC 中的 P 等）。
 *  - note：不影响已显示的字段（记录之外的 COPY 等）。
 */
import { t } from './i18n';
import { CopyIssue, CopyLayout, LayoutSelection, CopyRecord, Copybook } from './cobol/types';
import { Node, Directive, newNode, parseStatement } from './cobol/statement';
import { buildLayout } from './cobol/emit';
import { normalizeSource } from './cobol/source';
import { ParseOptions, pushIssue, expandStatements, applyReplaceStatements } from './cobol/copy';

/** 选用总长度等于记录长度的顶层定义；没有则用第一个 */
export function selectRecord(cb: Copybook, bodyLen: number): CopyRecord | undefined {
  return cb.records.find((r) => r.totalLength === bodyLen) ?? cb.records[0];
}

/** 按 REDEFINES 的选择展开一个 01 记录 */
export function layoutRecord(rec: CopyRecord, sel: LayoutSelection = {}): CopyLayout {
  return buildLayout(rec.root as Node, sel, rec.fileIssues);
}

export function parseCopybook(text: string, opts: ParseOptions = {}): Copybook {
  const fileIssues: CopyIssue[] = [];
  const roots: Node[] = [];
  const stack: Node[] = [];

  const statements = applyReplaceStatements(expandStatements(normalizeSource(text, fileIssues), opts, fileIssues, []), fileIssues);
  for (const st of statements) {
    let unexpanded: { name: string; reason: string } | undefined = st.copy;
    let parsed: Node | Directive | undefined;
    if (!unexpanded) {
      parsed = parseStatement(st.text);
      if (!parsed) {
        continue;
      }
      if (!('level' in parsed)) {
        unexpanded =
          parsed.kind === 'copy'
            ? { name: parsed.text, reason: t('cpy.copyNotFound', { member: parsed.text }) }
            : parsed.kind === 'replace'
              ? undefined
              : { name: '?', reason: t('cpy.unknownStmt', { stmt: parsed.text }) };
        if (parsed.kind === 'replace') {
          pushIssue(fileIssues, { level: 'layout', text: t('cpy.replace'), from: 0 });
          continue;
        }
      }
    }
    if (unexpanded) {
      // 记录定义的中途：在这个位置放一个占位项目，展开时从这里开始标为可疑
      const group = [...stack].reverse().find((n) => !n.pic);
      if (group) {
        const marker = newNode(stack[stack.length - 1].level);
        marker.marker = true;
        marker.name = `COPY ${unexpanded.name}`;
        marker.issues.push({ level: 'layout', text: unexpanded.reason });
        group.children.push(marker);
      } else if (stack.length > 0) {
        pushIssue(fileIssues, { level: 'layout', text: unexpanded.reason, from: 0 });
      } else {
        // 记录之外：已有的记录不受影响，但可能有记录没有显示出来
        pushIssue(fileIssues, { level: 'note', text: unexpanded.reason });
      }
      continue;
    }
    const node = parsed as Node;
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }

  const records: CopyRecord[] = [];
  for (const root of roots) {
    if (root.typedef) {
      continue; // 类型定义，不是记录
    }
    // 01 层的 REDEFINES 是同一区域的另一种记录定义，作为独立的 01 记录处理
    const layout = buildLayout(root, {}, fileIssues);
    if (layout.fields.length > 0) {
      records.push({ name: root.name, ...layout, root, fileIssues });
    }
  }
  const warnings = [...new Set([...fileIssues, ...records.flatMap((r) => r.issues)].map((x) => x.text))];
  const first = records[0];
  return { fields: first?.fields ?? [], totalLength: first?.totalLength ?? 0, records, warnings, issues: fileIssues };
}

export type { FieldType, CopyField, IssueLevel, CopyIssue, Trust, RedefineSet, CopyLayout, LayoutSelection, CopyRecord, Copybook } from './cobol/types';
export { picInfo } from './cobol/pic';
export type { PicInfo } from './cobol/pic';
export { copyReferences } from './cobol/copy';
export type { CopyMember, MemberResolver, ParseOptions } from './cobol/copy';
