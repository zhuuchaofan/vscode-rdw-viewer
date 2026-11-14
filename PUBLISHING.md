# 发布步骤

发布者 ID：`zhuuchaofan`　扩展 ID：`zhuuchaofan.rdw-viewer`

发布由 GitHub Actions 的 `.github/workflows/publish.yml` 完成：**推送 `v*` 标签**时，先跑测试，再用 OIDC 免令牌方式（Trusted Publishing）发布。仓库里不保存任何令牌。

> 根据以下官方文档整理（2026-11-13 读取）：
> - VS Code Marketplace：<https://code.visualstudio.com/api/working-with-extensions/publishing-extension>（源文件 `microsoft/vscode-docs`，DateApproved: 11/11/2026）
> - Open VSX：<https://github.com/eclipse/openvsx/wiki/Publishing-Extensions>、<https://github.com/eclipse/openvsx/wiki/Trusted-Publishing>

## 一次性设置

### 1. VS Code Marketplace：登记 Trusted Publishing

1. 打开 <https://marketplace.visualstudio.com/manage>，进入发布者 `zhuuchaofan`。
2. 选择 **Trusted Publishing** → 展开 **Create**，填写：

   | 字段 | 值 |
   | --- | --- |
   | Policy name | `Release workflow`（任意） |
   | Repository owner | `zhuuchaofan` |
   | Repository | `vscode-rdw-viewer` |
   | Workflow | `publish.yml` |
   | Environment | 留空 |

3. 点 **Create**。

这个设置是按发布者登记的，不按扩展。官方文档没有说明「第一个版本能否直接用 `--oidc` 发布」。如果首次发布在 `marketplace` 这一步失败，可以先在同一个管理页面手动上传 vsix 发布第一版，之后的版本再走工作流。

### 2. Open VSX：第一版用令牌手动发布，再登记 Trusted Publisher

Open VSX 规定第一个版本必须用访问令牌发布，扩展存在之后才能登记 Trusted Publisher。

1. 准备账号（已经有的可跳过）：
   - 在 <https://accounts.eclipse.org/user/register> 注册 Eclipse 账号，「GitHub Username」填 `zhuuchaofan`。
   - 用 GitHub 登录 <https://open-vsx.org>，在 <https://open-vsx.org/user-settings/profile> 点「Log in with Eclipse」，然后同意 Publisher Agreement。
2. 在 <https://open-vsx.org/user-settings/tokens> 生成访问令牌（只显示一次）。
3. 在本机项目目录设置令牌到环境变量（避免留在命令历史里），PowerShell：

```powershell
$env:OVSX_PAT = Read-Host -AsSecureString | ConvertFrom-SecureString -AsPlainText
```

4. 创建命名空间（如果 `zhuuchaofan` 已经存在会报错，可忽略）：

```powershell
npx ovsx create-namespace zhuuchaofan
```

5. 打包并发布第一版：

```powershell
npm ci
```

```powershell
npx vsce package
```

```powershell
npx ovsx publish rdw-viewer-$((Get-Content package.json | ConvertFrom-Json).version).vsix
```

（`npx vsce package` 生成的文件名是 `rdw-viewer-<package.json 的版本>.vsix`。这里发布的版本会成为 Open VSX 上的第一个版本，之后同一版本号不能再发布，下一次请先升版本号再走工作流。）

6. 登记 Trusted Publisher：打开 <https://open-vsx.org/user-settings/trusted-publishers>，选择命名空间 `zhuuchaofan` 和扩展，Provider 选 GitHub Actions：

   | 字段 | 值 |
   | --- | --- |
   | Organization or User name | `zhuuchaofan` |
   | Repository name | `vscode-rdw-viewer` |
   | Workflow filename | `publish.yml` |
   | Environment name | 留空 |

7. 在 GitHub 仓库 **Settings → Secrets and variables → Actions → Variables** 添加变量 `OPENVSX_TRUSTED`，值为 `true`。之后工作流会同时发布到 Open VSX。
8. 删除第 2 步的令牌（或保留以备手动发布）。

## 每次发布

1. 更新 `package.json` 的 `version` 和 `CHANGELOG.md`，合并到 `main`。
2. 在 `main` 上打标签并推送（标签必须与 `package.json` 的版本一致，否则工作流会报错停止）：

```bash
git checkout main
```

```bash
git pull
```

```bash
version="v$(node -p "require('./package.json').version")"
```

```bash
git tag "$version"
```

```bash
git push origin "$version"
```

3. 在 GitHub 的 **Actions → Publish** 查看结果，然后到两个市场的页面确认显示。

失败后修好问题，可以在 **Actions → Publish → Run workflow** 手动重新运行（发布的是当前 `package.json` 的版本；同一版本已经发布过的话会失败）。手动运行不会创建标签，需要的话之后在对应的提交上补打 `v<版本>` 标签。

## 发布前检查

- [ ] 在 VS Code 中实际用一遍主要功能，尤其是「按字段值区分」的配置流程。
- [ ] 本地 `npm test` 通过，`npx vsce package` 没有警告。
- [ ] 扩展名、显示名在 Marketplace 上唯一（官方要求；被删除的扩展名会被永久保留）。
