# npm 与国内镜像发布

状态：发布流程已准备，尚待维护者注册、登录 npm 并完成首次发布及镜像校验。本文中的包名安装命令只在同步成功后可用。

安装包的路径是 **GitHub Release → npm 官方仓库 → npmmirror**。npmmirror 是[只读的 npm 镜像](https://npmmirror.com/)，不能直接上传 `.tgz`，也不会代理 GitHub Release 下载地址。GitHub 与 npm 使用同一份发布包，避免重复打包产生内容差异。

## 首次发布 0.1.9

1. 在 [npm 注册页](https://www.npmjs.com/signup) 创建维护者账号，完成邮箱验证。随后在运行 Codex 的 Windows 电脑上打开 PowerShell，登录官方仓库：

   ```powershell
   npm.cmd login --registry=https://registry.npmjs.org
   npm.cmd whoami --registry=https://registry.npmjs.org
   ```

   密码、验证码和登录授权在 npm 的页面或终端完成，不要发送到聊天或提交进仓库。

2. 下载 [v0.1.9 Release](https://github.com/shixungan/dsh-ops-assistant/releases/tag/v0.1.9) 的 `dsh-ops-assistant-0.1.9.tgz`。在文件所在目录执行以下命令；只有 SHA-256 与已发布资产一致时才会继续发布：

   ```powershell
   $archivePath = (Resolve-Path '.\dsh-ops-assistant-0.1.9.tgz').Path
   $expectedHash = '43ad41ef3e04b5bc791934dfc0336d9180b0cdc6e2fae6a9a0bd4ada5bbb5328'
   if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) {
     throw '安装包校验失败，请重新下载同一 Release 的原始资产'
   }
   npm.cmd publish $archivePath --ignore-scripts --access public --registry=https://registry.npmjs.org
   if ($LASTEXITCODE -ne 0) { throw 'npm 发布未成功，请处理报错后继续' }
   ```

   使用原始 `.tgz`，不要从当前工作目录重新 `npm pack` 后冒用同一版本。npm 的[同名同版本不可覆盖或重复使用](https://docs.npmjs.com/cli/v11/commands/npm-publish/)；已存在的版本应核对内容，不通过删除旧版本解决冲突。

3. npm 发布成功后，在本项目源码根目录同步国内镜像：

   ```powershell
   node scripts/sync-npmmirror.mjs dsh-ops-assistant 0.1.9
   ```

   脚本先读取 npm 官方版本，再触发镜像同步；只有镜像版本与 `dist.integrity` 一致、且从镜像下载的安装包通过 SHA-512 校验才会报告成功。同步任务完成但文件仍在传播时会继续等待；超时或校验失败返回失败，可稍后重跑同步，无需再次发布 npm。

## 后续版本：GitHub Actions 发布

首次发布后，在 npm 的 `dsh-ops-assistant` 包设置中添加 **Trusted Publisher → GitHub Actions**：

| 字段 | 值 |
| --- | --- |
| Organization or user | `shixungan` |
| Repository | `dsh-ops-assistant` |
| Workflow filename | `npm-publish.yml`（只填文件名） |
| Environment name | 留空 |
| Allowed actions | 允许 `npm publish` |

此流程使用 GitHub 托管 runner 和 OIDC，不需要在仓库保存长期 npm Token。新配置须在两天内完成首次实际发布，因此应在下一版本准备好后配置；重跑已发布版本、只做同步不会验证新配置。字段和要求以 [npm Trusted Publishing 官方说明](https://docs.npmjs.com/trusted-publishers/)为准。

先按原流程生成新的 GitHub Release，再进入仓库 **Actions → npm-publish.yml 对应工作流 → Run workflow**，选择 `main` 并填写版本号，例如 `0.1.9`（不带 `v`）。工作流下载该版本已有的 `.tgz` 与校验文件，验证包信息后发布到 npm，再同步 npmmirror。如果 npm 已有同版本，仅在安装包完整性一致时跳过发布并继续同步。

该工作流目前仅支持手动 `workflow_dispatch`，不会随每次 push 自动发布。源码和 GitHub Release 的原有构建流程保持独立。

发布旧 Release 时，工作流显式关闭 provenance，避免把当前 `main` 提交误记为旧安装包的构建来源；仅当 Release 提交与工作流提交完全相同时才启用。两种情况都会校验原始安装包的哈希。

## 同步成功后的服务器安装

使用运行 DSH 的同一 Linux 用户、相同 profile 执行：

```bash
dsh plugin --profile web add -w dsh-ops-assistant@0.1.9 \
  --registry=https://registry.npmmirror.com
```

安装成功后重启已有 DSH 服务并刷新页面。后续升级将版本号替换为已完成镜像校验的新版本。国内镜像传播有延迟，不能仅根据 npm 发布成功就宣称国内安装包已可用。

## 准备工作验证

2026-11-12：本地构建与 215 项自动测试通过，包含发布防重复及国内镜像校验的 16 项模拟测试。已下载原始 v0.1.9 资产并验证上述 SHA-256，`npm publish --dry-run --ignore-scripts` 通过。尚未进行真实 npm 发布、Trusted Publisher 发布或镜像同步验收。
