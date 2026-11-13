# RDW Viewer

[日本語](README.md) | 中文

![截图](images/screenshot.png)

查看带 **RDW（Record Descriptor Word）** 的可变长记录文件的 VS Code 插件。每条记录一行，按 COBOL copybook 把字段横向展开显示。

## 文件格式

```text
[前置 RDW 4B][记录正文 N 字节][后置 RDW 4B]
```

- RDW 为小端序，前 2 字节 = 正文长度 N，后 2 字节不使用（界面不显示）。
- 前后 RDW 必须一致，据此识别记录边界。
- 正文默认按 Shift_JIS 解码，可在界面右上角切换编码，或通过设置 `rdwViewer.encoding` 修改默认值。

## 示例

[`examples/`](examples/) 中有可以直接体验的 RDW 文件和 copybook。**在 VS Code 中打开 `examples` 文件夹**（会自动使用其中的 `.vscode/rdw-viewer.json` 配置），右键各个 `.dat` →「用 RDW Viewer 打开」。

| 文件 | 内容 |
| --- | --- |
| `01-customer.dat` | 普通记录：日文、半角片假名、COMP-3、外部十进制。固定格式 copybook（带序号、标识区） |
| `02-mixed-length.dat` | 记录长度混合：头记录 40 / 明细 80 / 尾记录 30 字节 |
| `03-same-length.dat` | 长度相同（64），按记录类型（第 1 字节）切换 copybook |
| `04-redefines.dat` | REDEFINES：按支付方式切换信用卡 / 银行 / 现金布局 |
| `05-numeric.dat` | 各种 USAGE（外部十进制、SIGN SEPARATE、COMP-3、COMP、COMP-5、COMP-1/2）及非法数据示例 |
| `06-broken.dat` | RDW 错误：前后不一致、长度错误、文件截断 |
| `07-no-copybook.dat` | 没有 copybook：自动识别 COMP-3 |

示例可用 `npm run examples` 重新生成（`test/fixtures/examples.ts`）。

## 使用

在资源管理器中右键文件 → **用 RDW Viewer 打开**。

- **按长度分组**：同一文件里有多种长度的记录时，每种长度一个标签页，各自对应一个 copybook。
- **选择 copybook**：在标签页上方点「选择 copybook…」。没有设置的长度，如果工作区中总长度一致的 copybook 只有一个，会自动使用（标签页显示「自动」；不保存，点「清除」可停止自动选择）。工作区里总长度与记录长度一致的 `.cpy` 会排在最前面并带 ✓。选择结果保存到 `<工作区>/.vscode/rdw-viewer.json`（无工作区时保存到全局状态），下次打开自动应用。
- **文件顺序**：右上角「文件顺序」按原始顺序混排所有记录，copybook 切换处插入新的三行表头（項目名 / 属性 / 相対位置）。
- **版本**：工具栏文件名旁显示当前运行的插件版本。
- **界面语言**：默认日语；VS Code 的显示语言为中文时显示中文。
- **易读性**：隔行变色、选中行高亮、按类型着色（数值、FILLER、空白），末尾补位的空格显示为「·」「□」；文件顺序视图中不同 copybook 用色条区分。颜色跟随 VS Code 主题。
- **单元格数值**：点击数值字段的单元格，会同时显示解码后的数值（如 `PIC S9(5)V99` 的 `009876u` → `-987.65`）。
- **单元格详情**：点击单元格，在表格上方显示字段值和原始字节（十六进制），在表格下方显示整条记录的十六进制 dump。
- **错误**：长度越界、文件截断、前后 RDW 不一致都会在「错误」标签页和文件顺序视图中标红，写明偏移和原因，并尝试从后面的有效记录重新对齐。

### 导出（CSV / TSV）

- 每个标签页上方的「**导出…**」：把当前标签页导出为一个文件。
- 工具栏的「**全部导出…**」：选择文件夹，每个标签页各导出一个文件（如 `<文件名>_<长度>.csv`）；有错误时也导出错误列表。
- 导出时选择 CSV 或 TSV。第 1 行是字段名，第 2、3 行是属性和相对位置，每行前面是记录序号和偏移。
- 默认用 Shift_JIS 编码（设置 `rdwViewer.exportEncoding` 可改为带 BOM 的 UTF-8）。Shift_JIS 无法表示的字符替换为 `?`，并提示数量。
- COMP-3 等导出解码后的值。没有 copybook 时自动识别的 COMP-3 导出为 `[值]`，无法识别的字节导出为 `<十六进制>`。
- 大文件分批写入，不会占用大量内存；显示进度，可以中途取消（已取消的文件会被删除）。
- 文件顺序视图中各组的列不同，不能导出为一张表。

### 十六进制 dump

工具栏的「**HEX**」打开时，点击表格中的记录，会在表格下方显示该记录的十六进制 dump（偏移 / 16 字节十六进制 / 文字）。

- 按字段交替着色，选中的字段高亮。鼠标移到字节上显示位置（从 1 开始的位置和十六进制偏移）和字段名，点击字节会选中表格中对应的单元格。
- 同时显示前后 RDW。点击错误行时显示被跳过的字节（最多前 4096 字节）。
- 双字节字符显示在首字节的位置。拖动与表格之间的分隔条可以调整高度。

### 比较两个文件

在资源管理器中选中两个文件并右键 →「**用 RDW Viewer 比较**」。只选了一个文件，或从查看器工具栏的「**比较…**」进入时，再选择比较对象。

- **左右并排**：A、B 两个表格左右并排，上下、左右滚动同步。有差异的字段标黄，只在 A 的记录标红，只在 B 的记录标绿，另一侧插入斜线空行。
- **对应方式**：
  - **记录序号**：A 的第 n 条与 B 的第 n 条比较（RDW 错误条目不参与比较）。
  - **键项目**：从 A 的 copybook 字段中选择（可多选，拼接后比较），或按 `1-10`、`1-3,8-10` 的格式输入位置。即使有插入、删除、顺序变化，也会比较对应的记录。同一个键出现多次时按出现顺序对应。
- 勾选**只显示差异**只显示有差异和只在一侧的记录；「上一处差异」「下一处差异」（Shift+F7 / F7）跳转。
- 点击单元格并排显示 A / B 的值和十六进制；十六进制 dump 也左右并排，标出不同的字节。
- copybook 使用普通视图中按长度指定的设置（`.vscode/rdw-viewer.json`）。布局不同时按字段名对应比较。

### 同一长度、按字段值使用不同 copybook

记录长度相同但布局不同（例如头记录、明细记录、尾记录），可以按某个字段的值区分：

1. 在该长度的标签页上方点「**按字段值区分…**」。
2. 选择判别字段：可以直接选当前 copybook 中的字段（如 `レコードID`，COMP-3 字段会自动按数值比较），也可以手动输入起始位置、长度和类型（文字 / COMP-3）。
3. 插件列出该字段上出现的所有值及记录数，确认后每个值成为一个标签页，例如「1600 字节 = +10200」。
4. 在各标签页分别选择 copybook。没有对应 copybook 的值单独成组，显示整条正文。

判别字段的取值超过 50 种时会提示「可能选错了字段」并取消。点「取消区分」可恢复为按长度分组。
设置保存在 `.vscode/rdw-viewer.json` 的 `discriminators` 中：

```json
{
  "copybooks": { "2000": "copy/HEADER.cbl" },
  "discriminators": {
    "1600": {
      "start": 1, "length": 3, "type": "comp3",
      "copybooks": { "+10100": "copy/HEADER.cbl", "+10200": "copy/DETAIL.cbl" }
    }
  }
}
```

### REDEFINES：切换布局

REDEFINES 的原项目与重定义项目共用同一块区域，区域长度取其中最长的一个（不重复计算）。
默认按原项目的布局显示，在提示条下方的「**布局**」中切换（如 `REDEFINES PAY-CARD` → `PAY-BANK`）。

- 选择按标签页（长度，或按字段值区分的分组）保存在 `.vscode/rdw-viewer.json` 的 `layouts` 中。
- 与「按字段值区分」组合使用，例如支付方式为 `B` 的记录自动按银行布局显示（见 `examples/04-redefines.dat`）。
- 支持嵌套的 REDEFINES、OCCURS 中的 REDEFINES、REDEFINES 的 REDEFINES；同长度的多个 `01` 也在这里切换。

### 没有 copybook 时：自动识别 COMP-3

尚未指定 copybook 的记录显示为「整条正文」一列。工具栏的「**自动识别 COMP-3**」开启时（默认开启，设置 `rdwViewer.autoDetectPacked`），
会把正文切分成文字、COMP-3、无法识别的字节三类：

```text
[+10100]1ABCD-0001[+0][+0][+2241070][+2241086]
```

- `[ ]`（绿色）：猜测出的 COMP-3 数值。C/D 结尾带 `+`/`-`，F 结尾不带符号；不知道小数位，按整数显示。
- `‹ ›`（灰色）：既不是文字也不是 COMP-3 的字节，以十六进制显示。
- 末尾空格不显示；点击单元格可在上方查看完整内容和原始字节。

这是**启发式猜测，可能误判**。例如文字后面紧跟以 `0x20`（空格）开头的 COMP-3 时，这个空格会被当作文字末尾的空格。
需要准确结果时请指定 copybook；指定后不再自动识别。

### 长度与 copybook 不一致

| 情况 | 宽松模式（默认） | 严格模式 |
| --- | --- | --- |
| 正文比 copybook 长 | 多出的字节显示在「(余り)」列，标橙 | 不拆分，只显示整条正文 |
| 正文比 copybook 短 | 被截断的字段标橙，缺失字段显示 `—` | 同上 |
| `PIC 9` 字段含非数字、SJIS 解码失败 | 原样显示并标橙 | — |

通过 `rdwViewer.lengthMismatch` 切换模式。

### copybook 支持范围

支持：
- 固定/自由格式（逐行判断；1~6 列序号、73~80 列标识自动去除。列按字节计算，有日文项目名也不会错位）
- 层级号（77；66、88 跳过）、`FILLER`、`PIC X/A/9/S/V/P/Z…`、编辑项目、`PIC N` / `PIC G`（每字符 2 字节）
- 组项目的 `USAGE` / `SIGN` 由下级项目继承
- `SIGN [LEADING|TRAILING] [SEPARATE]`
- `OCCURS n`（嵌套时展开为 `name(1,2)`）
- `REDEFINES`（可切换，见上文）
- 多个 `01`：自动选用总长度等于记录长度的那个定义
- `COMPUTATIONAL-3` 等全称写法，没有 `PIC` 的 `COMP-1` / `COMP-2` / `INDEX`

不支持（会给出提示）：`OCCURS DEPENDING ON`（按最大次数展开）、`SYNC` 的对齐填充（不计算 slack byte）。

### 数值格式

数值字段解码后右对齐显示。重点是**不把错误数据显示成正常值**：内容非法的显示十六进制并标橙；能解码但可疑的（如超出位数）显示数值并标橙。有符号字段显示 `+` / `-`，无符号字段不带符号。

| USAGE | 显示 | 非法（十六进制、标橙） | 可疑（数值、标橙） |
| --- | --- | --- | --- |
| `COMP-3` / `PACKED-DECIMAL` | 按 `V` 插入小数点；符号 C/A/E/F 为正、D/B 为负 | 数字半字节不是 0~9、符号半字节非法 | 超出 PIC 位数（偶数位时最高的填充半字节不为 0）、无符号字段带负号 |
| `COMP` / `COMP-4` / `BINARY` | 二进制整数，字节序由 `rdwViewer.binaryEndian` 决定 | — | 超出 PIC 位数（TRUNC(STD) 下不会出现） |
| `COMP-5` | 本地二进制整数，字节序由 `rdwViewer.comp5Endian` 决定 | — | —（可以使用整个二进制范围） |
| `COMP-1` / `COMP-2` | 浮点数；`rdwViewer.floatFormat` 选择 IEEE 754 或 IBM 十六进制浮点 | NaN、无穷大、长度不对 | — |
| `DISPLAY`（外部十进制） | 表格中显示原始字符；点击单元格显示数值 | 空格、小数点等非数字字符，符号位置或字符不对 | — |

外部十进制的符号：`SIGN SEPARATE` 为 `+` / `-`；符号嵌入数字时，接受 ASCII 环境的 `p`~`y`（负），以及 EBCDIC 转换后的 `{A`~`I`（正）、`}J`~`R`（负）。

不同平台的参考设置：

| 数据来源 | `binaryEndian` | `comp5Endian` | `floatFormat` |
| --- | --- | --- | --- |
| 大型机（IBM 等，从 EBCDIC 转换） | `big` | `big` | `ibm` |
| Windows / Linux（x86）上的 COBOL | `big`（多数编译器的默认） | `little` | `ieee` |

copybook 总长度与记录长度对不上时，点提示条上的「**解析详情**」，会在编辑器中列出每个字段的位置、长度、属性以及解析提示，方便对照 copybook 原文找出差异。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `rdwViewer.encoding` | `shift_jis` | 默认字符编码 |
| `rdwViewer.lengthMismatch` | `lenient` | 长度不一致时的处理方式 |
| `rdwViewer.binaryEndian` | `big` | `COMP` / `COMP-4` / `BINARY` 字段的字节序（COMP-3 不受影响） |
| `rdwViewer.comp5Endian` | `followBinaryEndian` | `COMP-5` 和 `COMP-1` / `COMP-2` 的字节序（`big` / `little` / 与 binaryEndian 相同） |
| `rdwViewer.floatFormat` | `ieee` | `COMP-1` / `COMP-2` 的格式（`ieee` / `ibm`） |
| `rdwViewer.autoDetectPacked` | `true` | 没有 copybook 时自动识别 COMP-3 |
| `rdwViewer.exportEncoding` | `shift_jis` | 导出文件的编码（`shift_jis` / `utf-8-bom`） |
| `rdwViewer.hiddenFieldPattern` | `^FILLER$` | 「隐藏 FILLER 列」开关隐藏的字段名正则，如 `FILLER\|COMMA` |

## 发布

发布到 VS Code Marketplace 和 Open VSX 的步骤见 [PUBLISHING.md](PUBLISHING.md)。

## 开发

```bash
npm install     # 首次必须执行：安装 TypeScript 等开发依赖
npm test        # 编译并运行单元测试
npm run compile # 仅编译
```

打包成 vsix（会自动先编译）：

```bash
npx vsce package
```

按 F5 启动 Extension Development Host 调试。

目录结构：

- `src/rdw.ts` RDW 扫描与错误恢复
- `src/copybook.ts` copybook 解析
- `src/layout.ts` 列布局（长度不一致的处理）
- `src/i18n.ts` 界面文字（中文 / 日文）
- `src/export.ts` CSV / TSV 导出
- `src/numeric.ts` 数值解码（COMP-3 / COMP / COMP-5 / 浮点 / 外部十进制）
- `test/fixtures/examples.ts` 示例文件生成器
- `src/sjisEncode.ts` Shift_JIS 编码器
- `src/autodetect.ts` 无 copybook 时的 COMP-3 自动识别
- `src/numeric.ts` COMP-3 / COMP 解码
- `src/session.ts` 数据模型（分组、按需解码、虚拟滚动数据源）
- `src/extension.ts` VS Code 集成（命令、webview、copybook 映射存储）
- `media/` webview 前端（虚拟滚动表格）

以上模块中除 `extension.ts` 外都不依赖 VS Code，测试直接用 `node --test` 运行。
