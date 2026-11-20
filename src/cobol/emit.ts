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
  /** null 表示只测量长度（不生成 CopyField，按 OCCURS 乘法 O(AST) 计算） */
  out: CopyField[] | null;
  hasFields: boolean;
  sets: RedefineSet[];
  sel: LayoutSelection;
  issues: CopyIssue[];
  /** OCCURS DEPENDING ON 表的结束位置（全部展开后再判断后面有没有字段） */
  odo: Array<{ name: string; end: number }>;
}

function alignPad(offset: number, boundary: number): number {
  return boundary > 0 && offset % boundary !== 0 ? boundary - (offset % boundary) : 0;
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
  ctx.hasFields = true;
  if (!ctx.out) {
    return;
  }
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

/** 内部布尔项目（USAGE BIT 的基本项目）：按位分配 */
function isBitItem(node: Node, inh: Inherited): boolean {
  if (node.marker) return false;
  const me = inherit(node, inh);
  return me.usage === 'BIT' && isElementary(node, me.usage);
}

/**
 * 展开一串连续的内部布尔项目（NetCOBOL 文法書 BIT 句、ALIGNED 句）：
 * 每个项目（含 OCCURS 的每次重复）占 PIC 中 1 的个数那么多位，从前一个项目的下一位开始紧接着排列；
 * 整串从字节边界开始，结束时补齐到字节边界（之后的项目、组项目都从字节边界开始）。
 * 字段的偏移 / 长度为它的位所在的字节范围，bitOffset / bits 为字节内的位置和位数。
 */
function emitBits(run: Node[], offset: number, idx: number[], inh: Inherited, ctx: EmitCtx): number {
  let bit = 0;
  for (const node of run) {
    for (const is of node.issues) {
      addIssue(ctx, { ...is, from: offset + Math.floor(bit / 8) });
    }
    const me = inherit(node, inh);
    const n = picInfo(node.pic ?? '', 'DISPLAY', false).length;
    if (node.aligned && bit % 8 !== 0) {
      bit += 8 - (bit % 8);
    }
    if (node.occurs > 0) {
      ctx.hasFields = true;
      addIssue(ctx, { level: 'value', text: t('cpy.bit', { name: node.name }) });
    }
    if (!ctx.out) {
      bit += n * node.occurs;
    } else {
      for (let r = 1; r <= node.occurs; r++) {
        const ix = node.occurs > 1 ? [...idx, r] : idx;
        const start = Math.floor(bit / 8);
        const end = Math.ceil((bit + n) / 8);
        ctx.out.push({
          name: node.name + (ix.length ? `(${ix.join(',')})` : ''),
          pic: `${node.pic ?? ''} BIT`.trim(),
          offset: offset + start,
          length: Math.max(1, end - start),
          type: 'bin',
          signed: false,
          usage: me.usage,
          scale: 0,
          digits: 0,
          signSeparate: false,
          signLeading: false,
          bitOffset: bit - start * 8,
          bits: n,
        });
        bit += n;
      }
    }
    if (node.odo) {
      ctx.odo.push({ name: node.name, end: offset + Math.ceil(bit / 8) });
    }
  }
  return offset + Math.ceil(bit / 8);
}

/**
 * 展开（或仅测量）一个项目，返回结束偏移。
 *
 * SYNC 的填充字节按 NetCOBOL 文法書 1.3.5.1 插入（偏移从记录开头算起，01 从 8 字节边界开始）：
 *  1. 需要对齐的项目前面是基本项目时，填充放在它的紧前面；
 *  2. 需要对齐的项目是组项目的第一个项目时，填充放在「前面是基本项目」的最内层的那个组项目前面
 *     （不计入内层组项目的大小）。leading=true 表示这个项目是所在组的第一个项目，由上层负责对齐；
 *  3. 带 OCCURS 的组项目中有需要对齐的项目时，每次重复的末尾补齐到其中最大边界的倍数。
 *     因为固有边界都是 2 的幂（2/4/8），单次重复补齐后起始偏移对所有下级边界同余，
 *     所以仅测量时只需计算一次重复再乘以 occurs。
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
  if (elementary && me.usage === 'BIT') {
    return emitBits([node], offset, idx, inh, ctx);
  }
  let off = offset;
  const lead = leadBoundary(node, inh);
  const leadPad = !leading || elementary ? alignPad(off, lead) : 0;
  if (leadPad > 0) {
    pushSlack(ctx, off, leadPad);
    off += leadPad;
  }
  if (elementary) {
    const p = picInfo(node.pic ?? '', me.usage, me.sign.separate, node.intSigned);
    if (node.occurs > 0) {
      ctx.hasFields = true;
      if (me.usage === 'INDEX' || me.usage === 'POINTER') {
        addIssue(ctx, { level: 'layout', text: t('cpy.pointer', { name: node.name, usage: me.usage }), from: off });
      }
    }
    if (!ctx.out) {
      off += p.length * node.occurs;
    } else {
      const picText = node.pic ?? '';
      const picLabel = p.type === 'bin' ? `${picText} ${me.usage}`.trim() : picText;
      for (let r = 1; r <= node.occurs; r++) {
        const ix = node.occurs > 1 ? [...idx, r] : idx;
        ctx.out.push({
          name: node.name + (ix.length ? `(${ix.join(',')})` : ''),
          pic: picLabel,
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
      }
    }
  } else {
    const repAlign = node.occurs > 1 ? maxBoundary(node, inh) : 0;
    const childPath = node.name ? `${path}.${node.name}` : path;
    if (!ctx.out) {
      const repStart = off;
      off = emitChildren(node.children, off, idx, childPath, me, ctx);
      const pad = alignPad(off - repStart, repAlign);
      if (pad > 0) {
        pushSlack(ctx, off, pad);
        off += pad;
      }
      if (node.occurs > 1) {
        off = repStart + (off - repStart) * node.occurs;
      }
    } else {
      for (let r = 1; r <= node.occurs; r++) {
        const ix = node.occurs > 1 ? [...idx, r] : idx;
        const repStart = off;
        off = emitChildren(node.children, off, ix, childPath, me, ctx);
        const pad = alignPad(off - repStart, repAlign);
        if (pad > 0) {
          pushSlack(ctx, off, pad);
          off += pad;
        }
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
  const slots = groupSlots(children);
  for (let k = 0; k < slots.length; k++) {
    const slot = slots[k];
    if (slot.orphan) {
      // 找不到 REDEFINES 的对象：这个项目被忽略，它可能比原项目长，区域大小因此可能不对
      addIssue(ctx, { level: 'layout', text: t('cpy.redefinesTarget', { name: slot[0].name, target: slot[0].redefines ?? '' }), from: off });
      continue;
    }
    if (slot.length === 1 && isBitItem(slot[0], inh)) {
      // 连续的内部布尔项目按位紧接着排列，作为一组展开
      const run = [slot[0]];
      while (k + 1 < slots.length && slots[k + 1].length === 1 && !slots[k + 1].orphan && isBitItem(slots[k + 1][0], inh) && !slots[k + 1][0].aligned) {
        run.push(slots[++k][0]);
      }
      off = emitBits(run, off, idx, inh, ctx);
      first = false;
      continue;
    }
    if (slot.length === 1) {
      off = emit(slot[0], off, idx, path, inh, ctx, first);
      first &&= slot[0].marker;
      continue;
    }
    // REDEFINES：原项目按通常的规则对齐；重定义项目从同一位置开始（对齐由编写者负责，编译器不插入填充）
    const leadPad = first ? 0 : alignPad(off, leadBoundary(slot[0], inh));
    if (leadPad > 0) {
      pushSlack(ctx, off, leadPad);
      off += leadPad;
    }
    first = false;
    // 只展开选中的布局；未选中布局只测量长度与问题（不分配 CopyField），区域大小取各布局最大值
    const id = `${path}.${slot[0].name}`.replace(/^\./, '');
    const chosen = slot.find((c) => sameName(ctx.sel[id], c.name)) ?? slot[0];
    // 外层区域先登记（列表按出现顺序），长度在各布局展开后确定
    let set: RedefineSet | undefined;
    if (ctx.out) {
      set = ctx.sets.find((x) => x.id === id);
      if (!set) {
        set = { id, base: slot[0].name, options: slot.map((c) => c.name), offset: off, length: 0 };
        ctx.sets.push(set);
      }
    }
    let end = off;
    for (const c of slot) {
      if (c === chosen) {
        end = Math.max(end, emit(c, off, idx, path, inh, ctx, true));
        continue;
      }
      const hidden: EmitCtx = { out: null, hasFields: false, sets: [], sel: ctx.sel, issues: [], odo: [] };
      end = Math.max(end, emit(c, off, idx, path, inh, hidden, true));
      hidden.issues.filter((x) => x.level === 'layout').forEach((x) => addIssue(ctx, { ...x, from: off }));
      hidden.odo.forEach((o) => addIssue(ctx, { level: 'layout', text: t('cpy.odoLayout', { name: o.name }), from: off }));
    }
    if (set) {
      set.length = Math.max(set.length, end - off);
    }
    off = end;
  }
  return off;
}

const ROOT_INHERITED: Inherited = { usage: 'DISPLAY', sign: { separate: false, leading: false }, sync: false };

function trustOf(issues: CopyIssue[]): Trust {
  if (issues.some((x) => x.level === 'layout')) return 'untrusted';
  return issues.some((x) => x.level !== 'info') ? 'partial' : 'ok';
}

/** 只计算记录的总字节长度与是否包含字段，不分配 CopyField（O(AST 节点数)） */
export function measureLayout(root: Node, sel: LayoutSelection = {}): { totalLength: number; hasFields: boolean } {
  const ctx: EmitCtx = { out: null, hasFields: false, sets: [], sel, issues: [], odo: [] };
  const totalLength = emit(root, 0, [], '', ROOT_INHERITED, ctx, true);
  return { totalLength, hasFields: ctx.hasFields };
}

export function buildLayout(root: Node, sel: LayoutSelection, fileIssues: CopyIssue[]): CopyLayout {
  const out: CopyField[] = [];
  const ctx: EmitCtx = { out, hasFields: false, sets: [], sel, issues: [], odo: [] };
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
  for (const f of out) {
    if (f.offset >= firstBad) f.suspect = true;
  }
  return { fields: out, totalLength, sets: ctx.sets, issues: ctx.issues, trust: trustOf(ctx.issues) };
}
