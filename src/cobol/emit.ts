/**
 * 把解析树展开成字段列表：偏移、REDEFINES、OCCURS、SYNC 的填充字节，
 * 以及影响位置的问题（可信度）。
 */
import { t } from '../i18n';
import { CopyField, CopyIssue, Trust, RedefineSet, CopyLayout, LayoutSelection } from './types';
import { Node } from './statement';
import { NO_PIC_USAGES, picInfo } from './pic';

/** 从上级继承的属性 */
interface Inherited {
  usage: string;
  sign: { separate: boolean; leading: boolean };
  /** 组项目上的 SYNC 适用于下级的基本项目（NetCOBOL 的 Windows / Linux 版） */
  sync: boolean;
}

const sameName = (a: string | undefined, b: string) => (a ?? '').toUpperCase() === b.toUpperCase();

function isElementary(node: Node, usage: string): boolean {
  return !!node.pic || (node.children.length === 0 && NO_PIC_USAGES.has(usage));
}

function inherit(node: Node, from: Inherited): Inherited {
  return { usage: node.usage ?? from.usage, sign: node.sign ?? from.sign, sync: node.sync || from.sync };
}

/** 同一区域的项目：原项目 + 重定义项目。orphan=REDEFINES 的对象找不到（这个项目被忽略） */
type Slot = Node[] & { orphan?: boolean };

/** 把相邻的「原项目 + 重定义项目」归为一组；重定义项目的对象可以是原项目或同组中的另一项目 */
function groupSlots(children: Node[]): Slot[] {
  const slots: Slot[] = [];
  for (const c of children) {
    const last = slots[slots.length - 1];
    if (c.redefines) {
      if (last && !last.orphan && last.some((x) => sameName(c.redefines, x.name))) {
        last.push(c);
      } else {
        slots.push(Object.assign([c], { orphan: true }));
      }
      continue;
    }
    slots.push([c]);
  }
  return slots;
}

/** SYNC 时基本项目的固有边界（字节）；SYNC 不起作用的项目为 0（NetCOBOL 文法書 5.4.12） */
function syncBoundary(usage: string, digits: number): number {
  switch (usage) {
    case 'BINARY':
    case 'COMP':
    case 'COMP-4':
    case 'COMP-5':
      return digits <= 4 ? 2 : 4;
    case 'COMP-1':
    case 'INDEX':
    case 'POINTER':
      return 4;
    case 'COMP-2':
      return 8;
    default:
      return 0;
  }
}

interface EmitCtx {
  out: CopyField[];
  sets: RedefineSet[];
  sel: LayoutSelection;
  issues: CopyIssue[];
  /** OCCURS DEPENDING ON 表的结束位置（全部展开后再判断后面有没有字段） */
  odo: Array<{ name: string; end: number }>;
}

/** 记录问题：同一问题只记一次，位置取最靠前的 */
function addIssue(ctx: EmitCtx, issue: CopyIssue): void {
  const same = ctx.issues.find((x) => x.level === issue.level && x.text === issue.text);
  if (!same) {
    ctx.issues.push({ ...issue });
  } else if (issue.from !== undefined && (same.from === undefined || issue.from < same.from)) {
    same.from = issue.from;
  }
}

/** 项目开头（第一个基本项目）要求的边界：SYNC 时为该项目的固有边界，否则为 0 */
function leadBoundary(node: Node, inh: Inherited): number {
  if (node.marker) {
    return 0;
  }
  const me = inherit(node, inh);
  if (isElementary(node, me.usage)) {
    return me.sync ? syncBoundary(me.usage, picInfo(node.pic ?? '', me.usage, me.sign.separate, node.intSigned).digits) : 0;
  }
  const first = groupSlots(node.children).find((sl) => !sl.orphan && !sl[0].marker);
  return first ? leadBoundary(first[0], me) : 0;
}

/** 项目中所有 SYNC 基本项目的边界的最大值（OCCURS 的每次重复按它补齐） */
function maxBoundary(node: Node, inh: Inherited): number {
  if (node.marker) {
    return 0;
  }
  const me = inherit(node, inh);
  if (isElementary(node, me.usage)) {
    return me.sync ? syncBoundary(me.usage, picInfo(node.pic ?? '', me.usage, me.sign.separate, node.intSigned).digits) : 0;
  }
  return Math.max(0, ...node.children.map((c) => maxBoundary(c, me)));
}

/** 编译器插入的填充字节（遊びバイト）：作为隐含的 FILLER 显示 */
function pushSlack(ctx: EmitCtx, offset: number, length: number): void {
  ctx.out.push({
    name: 'FILLER',
    pic: `X(${length})`,
    offset,
    length,
    type: 'alnum',
    signed: false,
    usage: 'DISPLAY',
    scale: 0,
    digits: 0,
    signSeparate: false,
    signLeading: false,
  });
}

/**
 * 展开一个项目，返回结束偏移。
 *
 * SYNC 的填充字节按 NetCOBOL 文法書 1.3.5.1 插入（偏移从记录开头算起，01 从 8 字节边界开始）：
 *  1. 需要对齐的项目前面是基本项目时，填充放在它的紧前面；
 *  2. 需要对齐的项目是组项目的第一个项目时，填充放在「前面是基本项目」的最内层的那个组项目前面
 *     （不计入内层组项目的大小）。leading=true 表示这个项目是所在组的第一个项目，由上层负责对齐；
 *  3. 带 OCCURS 的组项目中有需要对齐的项目时，每次重复的末尾补齐到其中最大边界的倍数。
 */
function emit(node: Node, offset: number, idx: number[], path: string, inh: Inherited, ctx: EmitCtx, leading = false): number {
  for (const is of node.issues) {
    addIssue(ctx, { ...is, from: offset });
  }
  if (node.marker) {
    return offset;
  }
  const me = inherit(node, inh);
  const elementary = isElementary(node, me.usage);
  // 已经报告过这一项的长度问题（TYPE 等）时，不再重复报告「没有 PIC」
  if (!elementary && node.children.length === 0 && !node.issues.some((x) => x.level === 'layout')) {
    addIssue(ctx, { level: 'layout', text: t('cpy.noPic', { name: node.name }), from: offset });
  }
  let off = offset;
  const lead = leadBoundary(node, inh);
  if (lead > 0 && off % lead !== 0 && (!leading || elementary)) {
    const pad = lead - (off % lead);
    pushSlack(ctx, off, pad);
    off += pad;
  }
  const repAlign = !elementary && node.occurs > 1 ? maxBoundary(node, inh) : 0;
  for (let r = 1; r <= node.occurs; r++) {
    const ix = node.occurs > 1 ? [...idx, r] : idx;
    const repStart = off;
    if (elementary) {
      const p = picInfo(node.pic ?? '', me.usage, me.sign.separate, node.intSigned);
      const picText = node.pic ?? '';
      if (me.usage === 'INDEX' || me.usage === 'POINTER') {
        addIssue(ctx, { level: 'layout', text: t('cpy.pointer', { name: node.name, usage: me.usage }), from: off });
      } else if (me.usage === 'BIT') {
        addIssue(ctx, { level: 'layout', text: t('cpy.bit', { name: node.name }), from: off });
      }
      ctx.out.push({
        name: node.name + (ix.length ? `(${ix.join(',')})` : ''),
        pic: p.type === 'bin' ? `${picText} ${me.usage}`.trim() : picText,
        offset: off,
        length: p.length,
        type: p.type,
        signed: p.signed,
        usage: me.usage,
        scale: p.scale,
        digits: p.digits,
        signSeparate: p.signed && me.sign.separate,
        signLeading: p.signed && me.sign.leading,
      });
      off += p.length;
    } else {
      off = emitChildren(node.children, off, ix, `${path}.${node.name}`, me, ctx);
      const size = off - repStart;
      if (repAlign > 0 && size % repAlign !== 0) {
        const pad = repAlign - (size % repAlign);
        pushSlack(ctx, off, pad);
        off += pad;
      }
    }
  }
  if (node.odo) {
    ctx.odo.push({ name: node.name, end: off });
  }
  return off;
}

function emitChildren(children: Node[], offset: number, idx: number[], path: string, inh: Inherited, ctx: EmitCtx): number {
  let off = offset;
  /** 还没有展开任何项目：下一个项目是这个组的第一个项目 */
  let first = true;
  for (const slot of groupSlots(children)) {
    if (slot.orphan) {
      // 找不到 REDEFINES 的对象：这个项目被忽略，它可能比原项目长，区域大小因此可能不对
      addIssue(ctx, { level: 'layout', text: t('cpy.redefinesTarget', { name: slot[0].name, target: slot[0].redefines ?? '' }), from: off });
      continue;
    }
    if (slot.length === 1) {
      off = emit(slot[0], off, idx, path, inh, ctx, first);
      first &&= slot[0].marker;
      continue;
    }
    // REDEFINES：原项目按通常的规则对齐；重定义项目从同一位置开始（对齐由编写者负责，编译器不插入填充）
    const lead = first ? 0 : leadBoundary(slot[0], inh);
    if (lead > 0 && off % lead !== 0) {
      const pad = lead - (off % lead);
      pushSlack(ctx, off, pad);
      off += pad;
    }
    first = false;
    // 只展开选中的布局；区域大小取各布局实际展开后的最大值（含填充），未选中布局中的问题也会影响区域大小
    const id = `${path}.${slot[0].name}`.replace(/^\./, '');
    const chosen = slot.find((c) => sameName(ctx.sel[id], c.name)) ?? slot[0];
    // 外层区域先登记（列表按出现顺序），长度在各布局展开后确定
    let set = ctx.sets.find((x) => x.id === id);
    if (!set) {
      set = { id, base: slot[0].name, options: slot.map((c) => c.name), offset: off, length: 0 };
      ctx.sets.push(set);
    }
    let end = off;
    for (const c of slot) {
      if (c === chosen) {
        end = Math.max(end, emit(c, off, idx, path, inh, ctx, true));
        continue;
      }
      const hidden: EmitCtx = { out: [], sets: [], sel: ctx.sel, issues: [], odo: [] };
      end = Math.max(end, emit(c, off, idx, path, inh, hidden, true));
      hidden.issues.filter((x) => x.level === 'layout').forEach((x) => addIssue(ctx, { ...x, from: off }));
      hidden.odo.forEach((o) => addIssue(ctx, { level: 'layout', text: t('cpy.odoLayout', { name: o.name }), from: off }));
    }
    set.length = Math.max(set.length, end - off);
    off = end;
  }
  return off;
}

const ROOT_INHERITED: Inherited = { usage: 'DISPLAY', sign: { separate: false, leading: false }, sync: false };

function trustOf(issues: CopyIssue[]): Trust {
  if (issues.some((x) => x.level === 'layout')) return 'untrusted';
  return issues.some((x) => x.level !== 'info') ? 'partial' : 'ok';
}

export function buildLayout(root: Node, sel: LayoutSelection, fileIssues: CopyIssue[]): CopyLayout {
  const ctx: EmitCtx = { out: [], sets: [], sel, issues: [], odo: [] };
  const totalLength = emit(root, 0, [], '', ROOT_INHERITED, ctx, true);
  // OCCURS DEPENDING ON：后面还有字段时，那些字段的位置随实际次数变化；在记录末尾时只有超出实际次数的部分无效
  for (const o of ctx.odo) {
    if (o.end < totalLength) {
      addIssue(ctx, { level: 'layout', text: t('cpy.odoLayout', { name: o.name }), from: o.end });
    } else {
      addIssue(ctx, { level: 'value', text: t('cpy.odoTail', { name: o.name }) });
    }
  }
  fileIssues.forEach((x) => addIssue(ctx, x));
  // 第一个位置可能不对的地方之后的字段都标为可疑
  const froms = ctx.issues.filter((x) => x.level === 'layout').map((x) => x.from ?? 0);
  const firstBad = froms.length > 0 ? Math.min(...froms) : Infinity;
  for (const f of ctx.out) {
    if (f.offset >= firstBad) f.suspect = true;
  }
  return { fields: ctx.out, totalLength, sets: ctx.sets, issues: ctx.issues, trust: trustOf(ctx.issues) };
}
