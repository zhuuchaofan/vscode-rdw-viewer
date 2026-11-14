/** copybook 解析结果的类型（字段、问题、布局、copybook）。 */
export type FieldType = 'alnum' | 'num' | 'bin';

export interface CopyField {
  name: string;
  /** PIC 原文（大写），二进制类字段会附带 USAGE */
  pic: string;
  /** 在正文中的偏移（从 0 开始） */
  offset: number;
  length: number;
  type: FieldType;
  signed: boolean;
  /** USAGE（DISPLAY / COMP / COMP-3 …） */
  usage: string;
  /**
   * 小数位数：V 之后的位数。PIC 中有 P 时：P 在左边（PP99 / VPP99）为 P 和 9 的个数之和；
   * P 在右边（99PP）为负数，表示末尾补 0
   */
  scale: number;
  /** PIC 中 9 的个数（数值项目的位数） */
  digits: number;
  /** 符号单独占 1 字节（SIGN SEPARATE） */
  signSeparate: boolean;
  /** 符号在前（SIGN LEADING）；默认在后 */
  signLeading: boolean;
  /** 位于无法准确计算位置的定义之后：位置、长度可能与实际不同 */
  suspect?: boolean;
}

/**
 * 问题的影响程度：layout=位置 / 长度可能不对；value=数值解释可能不对；note=不影响已显示的字段，但需要注意；
 * info=说明（展开了哪个 COPY 等），不影响可信度
 */
export type IssueLevel = 'layout' | 'value' | 'note' | 'info';

export interface CopyIssue {
  level: IssueLevel;
  text: string;
  /** layout 问题：从记录中的这个偏移（从 0 开始）起，字段的位置可能不对 */
  from?: number;
}

/** 布局的可信度：ok=有依据；partial=位置可靠但有未支持的语义；untrusted=位置可能不对 */
export type Trust = 'ok' | 'partial' | 'untrusted';

/** 一组可以切换的布局：REDEFINES 的原项目和重定义项目 */
export interface RedefineSet {
  /** 原项目的限定名（如 REC.PAY-INFO.CARD），用来保存选择 */
  id: string;
  /** 原项目名 */
  base: string;
  /** 可选的布局名（第一个为原项目） */
  options: string[];
  /** 区域的起始偏移（从 0 开始）和长度 */
  offset: number;
  length: number;
}

/** 按某种 REDEFINES 选择展开后的布局 */
export interface CopyLayout {
  fields: CopyField[];
  totalLength: number;
  /** 这个布局里出现的可切换区域 */
  sets: RedefineSet[];
  /** 这个布局的问题（含整个 copybook 层面的问题） */
  issues: CopyIssue[];
  trust: Trust;
}

/** REDEFINES 的选择：区域 id → 布局名 */
export type LayoutSelection = Record<string, string>;

/** copybook 中的一个顶层（01）记录定义（fields / totalLength / sets / issues 为默认布局） */
export interface CopyRecord extends CopyLayout {
  name: string;
  /** 解析树（内部使用） */
  readonly root: unknown;
  /** 整个 copybook 层面的问题（内部使用，展开布局时并入 issues） */
  readonly fileIssues: CopyIssue[];
}

export interface Copybook {
  /** 第一个顶层记录的字段（便于只有一个 01 的常见情况） */
  fields: CopyField[];
  totalLength: number;
  /** 所有顶层记录；有多个 01 时可按记录长度选用 */
  records: CopyRecord[];
  /** 所有问题的文字（整个 copybook 层面 + 各记录的默认布局，去重） */
  warnings: string[];
  /** 整个 copybook 层面的问题（不属于某个记录） */
  issues: CopyIssue[];
}
