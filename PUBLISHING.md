# 发布步骤

> 本说明根据以下官方文档整理（2026-11-13 读取），发布前请再核对一遍：
> - VS Code Marketplace：<https://code.visualstudio.com/api/working-with-extensions/publishing-extension>（源文件 `microsoft/vscode-docs`，DateApproved: 11/11/2026）
> - Open VSX：<https://github.com/eclipse/openvsx/wiki/Publishing-Extensions>

**令牌只在你自己的电脑或 CI 的密钥里使用，不要提交到仓库，也不要贴到聊天里。**

## 0. 发布前检查

- [ ] `package.json` 的 `publisher` 改成你的发布者 ID（现在是占位的 `local`）。两个市场都用这个 ID：Marketplace 的发布者 ID，Open VSX 的命名空间。
- [ ] 确认插件名 `rdw-viewer` 和显示名 `RDW Viewer` 在 Marketplace 上没有被占用（官方要求扩展名、显示名都唯一；被删除的扩展名也会被永久保留）。
- [ ] README 中的截图使用相对路径，`vsce` 会根据 `repository` 字段改写成 GitHub 地址。**仓库需要是公开的**，否则市场页面上的图片无法显示。
- [ ] 在 VS Code 中实际用一遍主要功能，尤其是「按字段值区分」的配置流程。
- [ ] 更新 `CHANGELOG.md` 和 `package.json` 的 `version`。
- [ ] 打包确认没有警告：

```bash
npm install
npx @vscode/vsce package
```

## 1. VS Code Marketplace

### 重要：Azure DevOps 全局 PAT 于 2026-12-01 停用

官方文档写明：*"On December 1, 2026, global Personal Access Tokens (PATs) in Azure DevOps are retired."*
Marketplace 用的 PAT 必须选 **All accessible organizations**（全局 PAT），所以 12 月 1 日之后这种方式将无法使用。官方推荐改用免令牌的方式发布：

- **GitHub Actions（Trusted Publishing）**：在发布者管理页面的「Trusted Publishing」中登记本仓库的工作流，工作流里执行 `npx @vscode/vsce publish --oidc`。凭证 15 分钟失效，不需要保存令牌。
- **Azure Pipelines + Microsoft Entra ID**：`vsce publish --azure-credential`（需要 vsce 2.26.1 以上）。

### 创建发布者

1. 打开 <https://marketplace.visualstudio.com/manage>，用 Microsoft 账号登录。
2. 左侧点「Create publisher」，填写：
   - **ID**：唯一，**创建后不能修改**。填到 `package.json` 的 `publisher`。
   - **Name**：唯一的显示名称。

### 方式 A：PAT（只能在 2026-12-01 之前使用，官方不推荐）

1. 在 Azure DevOps 创建 Personal Access Token：
   - Organization：**All accessible organizations**（选特定组织会出现 401/403）
   - Scopes：**Custom defined** → **Show all scopes** → **Marketplace** → **Manage**
2. 登录并发布：

```bash
npx @vscode/vsce login <发布者ID>
```

```bash
npx @vscode/vsce publish
```

`login` 时会提示输入 PAT。

### 方式 B：GitHub Actions（推荐，长期可用）

在发布者页面配置 Trusted Publishing 后，用工作流执行：

```bash
npx @vscode/vsce publish --oidc
```

需要的话，我可以帮你写这个工作流文件。

## 2. Open VSX（Antigravity、Cursor、VSCodium 等使用）

1. 在 <https://accounts.eclipse.org/user/register> 注册 Eclipse 账号，「GitHub Username」填你登录 open-vsx.org 用的 GitHub 账号。
2. 用 GitHub 登录 <https://open-vsx.org>。
3. 打开 <https://open-vsx.org/user-settings/profile>，点「Log in with Eclipse」授权，然后点「Show Publisher Agreement」，读完点「Agree」。
4. 在 <https://open-vsx.org/user-settings/tokens> 点「Generate New Token」，复制令牌（只显示一次）。
5. 创建命名空间（只需一次，名字与 `publisher` 相同）：

```bash
npx ovsx create-namespace <发布者ID> -p <令牌>
```

6. 发布打好的 vsix：

```bash
npx ovsx publish rdw-viewer-0.2.0.vsix -p <令牌>
```

为避免令牌留在命令历史里，也可以先设置环境变量 `OVSX_PAT`，再省略 `-p`。PowerShell：

```powershell
$env:OVSX_PAT = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
```

Open VSX 也支持 GitHub Actions 免令牌发布（`npx ovsx publish --trusted-publishing`），但**第一个版本必须用令牌发布**。

## 3. 发布后

- 在两个市场的页面上确认图标、截图、说明是否正常显示。
- 打 git 标签，例如 `v0.2.0`。
