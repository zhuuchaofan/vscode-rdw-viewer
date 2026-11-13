# RDW Viewer

查看带 **RDW（Record Descriptor Word）** 的可变长记录文件的 VS Code 插件，界面参考 TF-LINDA：每条记录一行，字段横向展开。

## 文件格式

```text
[前置 RDW 4B][记录正文 N 字节][后置 RDW 4B]
```

- RDW 为小端序，前 2 字节 = 正文长度 N，后 2 字节不使用（界面不显示）。
- 前后 RDW 必须一致，据此识别记录边界。
- 正文默认按 Shift_JIS 解码，可在界面右上角切换编码，或通过设置 `rdwViewer.encoding` 修改默认值。

## 使用

在资源管理器中右键文件 → **用 RDW Viewer 打开**。

- **按长度分组**：同一文件里有多种长度的记录时，每种长度一个标签页，各自对应一个 copybook。
- **选择 copybook**：在标签页上方点「选择 copybook…」。工作区里总长度与记录长度一致的 `.cpy` 会排在最前面并带 ✓。选择结果保存到 `<工作区>/.vscode/rdw-viewer.json`（无工作区时保存到全局状态），下次打开自动应用。
- **文件顺序**：右上角「文件顺序」按原始顺序混排所有记录，copybook 切换处插入新的三行表头（項目名 / 属性 / 相対位置）。
- **单元格详情**：点击单元格，在表格上方显示字段值和原始字节（十六进制）。
- **错误**：长度越界、文件截断、前后 RDW 不一致都会在「错误」标签页和文件顺序视图中标红，写明偏移和原因，并尝试从后面的有效记录重新对齐。

### 长度与 copybook 不一致

| 情况 | 宽松模式（默认） | 严格模式 |
| --- | --- | --- |
| 正文比 copybook 长 | 多出的字节显示在「(余り)」列，标橙 | 不拆分，只显示整条正文 |
| 正文比 copybook 短 | 被截断的字段标橙，缺失字段显示 `—` | 同上 |
| `PIC 9` 字段含非数字、SJIS 解码失败 | 原样显示并标橙 | — |

通过 `rdwViewer.lengthMismatch` 切换模式。

### copybook 支持范围

支持：固定/自由格式、层级号、`FILLER`、`PIC X/A/9/S/V/Z…`、`SIGN … SEPARATE`、`OCCURS n`（展开为 `name(1)…`）、`COMP`/`COMP-3` 等（只计算长度，按十六进制显示）。

不支持（会给出提示）：`REDEFINES`（忽略，不占位置）、`OCCURS DEPENDING ON`（按最大次数展开）、多个 `01`（只用第一个）。

## 设置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `rdwViewer.encoding` | `shift_jis` | 默认字符编码 |
| `rdwViewer.lengthMismatch` | `lenient` | 长度不一致时的处理方式 |
| `rdwViewer.hiddenFieldPattern` | `^FILLER$` | 「隐藏 FILLER 列」开关隐藏的字段名正则，如 `FILLER\|COMMA` |

## 开发

```bash
npm install
npm test        # 编译并运行单元测试
npm run compile # 仅编译
```

按 F5 启动 Extension Development Host 调试。

目录结构：

- `src/rdw.ts` RDW 扫描与错误恢复
- `src/copybook.ts` copybook 解析
- `src/layout.ts` 列布局（长度不一致的处理）
- `src/session.ts` 数据模型（分组、按需解码、虚拟滚动数据源）
- `src/extension.ts` VS Code 集成（命令、webview、copybook 映射存储）
- `media/` webview 前端（虚拟滚动表格）

以上模块中除 `extension.ts` 外都不依赖 VS Code，测试直接用 `node --test` 运行。
