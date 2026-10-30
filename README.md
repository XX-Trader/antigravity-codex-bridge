# Antigravity Codex Bridge

让 Antigravity 负责理解需求、分析与验收，让本机 Codex CLI 实际执行任务。

这是一个 Windows 优先的本地 stdio MCP 服务，不需要 npm 运行依赖，也不复制 Codex 登录凭证。默认启用完整文件系统/命令网络访问和实时联网搜索，适用于你信任的本机项目；不要接到不可信工作区或远程公开端口。

## 能解决什么

- 后台提交后立即返回，Antigravity 可以继续正常对话，不用反复调用模型查询进度。
- 一个事项对应一个 Codex 会话；保留 job、topic、session 身份，重启后找回并继续，不从头重派。
- 完成、需要选择或方案阻塞时，通过可选的原生 Sidecar 向原 Antigravity 会话发送一次事件。
- 返回 Codex 原生聊天链接，可查看已保存的任务、工具过程和最终回复；标题使用具体执行任务。
- 默认完整访问和 `web_search="live"`，支持显式收窄权限、多个项目独立注册、同根串行、防重复执行和受控容量续跑。
- 模型默认继承你的 Codex 配置，也可以指定账号可用的模型 ID 或本机别名；不自动换模型。

## 环境

- Windows、Node.js 22+、PowerShell 7。
- 已安装并登录的 Codex CLI。开发验收使用 Codex 0.164.0；其它版本需要自行验证兼容性。
- Antigravity 支持本地 MCP。自动回执另外依赖该产品版本提供 Sidecars 和 `agentapi`。
- Codex VS Code 扩展与 CLI 使用同一本机历史目录。SSH/WSL 中另一套历史不能用本机链接代替。

## 快速配置

先克隆仓库，并指定你的真实源码目录、外部运行目录和 Codex 程序路径。下面是占位示例，必须替换路径：

```pwsh
git clone https://github.com/XX-Trader/antigravity-codex-bridge.git
cd antigravity-codex-bridge
pwsh -NoProfile -File scripts/Setup.ps1 --project 'C:/work/my-project' --data 'C:/codex-runtime/my-project' --codex 'C:/tools/codex.exe' --pwsh 'C:/Program Files/PowerShell/7/pwsh.exe'
```

默认只预览，不写配置。确认你接受该项目的完整执行权限后，再加：

```pwsh
pwsh -NoProfile -File scripts/Setup.ps1 --project 'C:/work/my-project' --data 'C:/codex-runtime/my-project' --codex 'C:/tools/codex.exe' --pwsh 'C:/Program Files/PowerShell/7/pwsh.exe' --apply --trust-full-access
```

脚本合并本服务的 MCP 条目、定向工具 hook 和项目规则引用，保留其它服务及项目说明。运行数据放在你指定的外部目录，不要求特定盘符。已有项目的数据目录不允许悄悄换掉；迁移应先保留完整运行单元。

需要自动完成通知时，再提供已安装 Antigravity 的原生语言服务路径：

```pwsh
pwsh -NoProfile -File scripts/Setup.ps1 --project 'C:/work/my-project' --data 'C:/codex-runtime/my-project' --codex 'C:/tools/codex.exe' --pwsh 'C:/Program Files/PowerShell/7/pwsh.exe' --agentapi 'C:/path/to/Antigravity/resources/bin/language_server.exe' --apply --trust-full-access
```

安装后在 Antigravity 刷新 `codex-executor`，并重新载入项目规则。脚本不会重启应用、取消后台任务或修改 Codex 全局配置。旧进程仍使用启动时的代码，不能把文件更新当成已热加载。

完整参数、手动配置和回滚见 [配置说明](docs/configuration.md)。项目编排规则正文只有一份：[Antigravity 项目说明](.agents/rules/antigravity-codex.md)。

## 常用工具

| 工具 | 用途 |
| --- | --- |
| `codex_run` | 提交一个具体事项；默认后台返回，`wait=true` 只在明确要求等待时使用 |
| `codex_list` | 重启后按项目找回最近任务 |
| `codex_sessions` | 查看当前项目的原生会话摘要和聊天链接 |
| `codex_result` | 领取原回执，或查看最后已落盘进度；`sync_title=true` 可补齐已结束旧任务的标题 |
| `codex_wait` | 一次等待既有任务完成，不重新提交 |
| `codex_cancel` | 只取消该任务拥有的子进程，不回滚源码改动 |

`topic` 应是“修复播放器切集失败”这样的实际任务，而不是“Codex 执行者”。收到结果后，把 `chat.vscode_uri` 以可点击链接展示给用户。`chat=null` 可能只是尚未取得原生会话 ID，不是重复提交的理由。

扩展可能不在历史侧栏列出 `exec` 来源的会话，本项目提供准确会话 ID 的打开入口，不伪造来源或编辑 Codex 数据库。链接路由依赖扩展版本；聊天内容是 Codex 已保存、允许展示的历史，不包含未公开的内部推理。`progress` 是最后落盘事件，不是实时心跳。

## 验证

纯协议/安装器测试不调用模型，不需要 Codex 登录，也不连接业务数据库：

```pwsh
pwsh -NoProfile -Command 'npm test'
```

测试使用外部临时目录。需要指定存储位置时，先设置 `CODEX_EXECUTOR_TEST_ROOT` 和 `CODEX_EXECUTOR_PWSH`。开发者自己的存储规范优先，测试不固定写入某个盘符。

注册检查不发起模型任务：

```pwsh
pwsh -NoProfile -Command 'node scripts/verify.cjs --config C:/path/to/mcp_config.json'
```

显式加 `--smoke` 或 `--write-smoke` 才会调用真实 Codex，可能消耗账号额度；不要在同一项目已有任务运行时启动测试。单元测试、原生协议验证、Antigravity 的真实通知/界面验收是不同层级，不能互相替代。

## 边界

- 完整访问仍受当前系统账号、网络和上游服务权限约束；项目注册和串行锁不是安全沙箱。
- `completed` 只表示 CLI 正常结束，仍需核对命令、输出、测试和用户验收条件。
- 精确的模型容量错误才会同模型、同会话续跑；脚本等待，不用模型轮询，不从头重放未知副作用。
- 运行记录不自动按年龄删除。未知文件、仍需续接的任务和唯一证据不能当缓存清理。
- 不上传凭证、私人工作区路径、任务日志、回执或安装回滚状态。见 [安全说明](SECURITY.md)。

依据：[Antigravity MCP](https://antigravity.google/docs/mcp)、[Hooks](https://antigravity.google/docs/hooks)、[Sidecars](https://antigravity.google/docs/sidecars)、[Rules](https://antigravity.google/docs/rules)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 联网搜索](https://learn.chatgpt.com/docs/web-search)。
