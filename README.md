# Antigravity Codex Bridge

让 Antigravity 理解需求、提出方案并验收，由本机 Codex CLI 独立审核，通过后执行任务。

执行和子 agent 都属于 Codex：Antigravity 不用自己的原生子 agent、命令或写文件工具代做。需要细分时，由 Codex 会话调用自己的原生 `spawn_agent` 并汇总结果。桥接启动时显式启用 `features.multi_agent=true`，不覆盖用户的原生子线程数量配置；这与多个独立顶层 Codex 任务是两件事。

这是一个 Windows 优先的本地 stdio MCP 服务，不需要 npm 运行依赖，也不复制 Codex 登录凭证。默认启用完整文件系统/命令网络访问和实时联网搜索，适用于你信任的本机项目；不要接到不可信工作区或远程公开端口。

## 能解决什么

- 后台提交后立即返回，Antigravity 可以继续正常对话，不用反复调用模型查询进度。
- 一个事项对应一个 Codex 会话；保留 job、topic、session 身份，重启后找回并继续，不从头重派。
- 开始执行、原生会话建立、文件变更、测试/构建/提交阶段、容量等待和结束时，通过可选的原生 Sidecar 向原聊天推送关键变化；不是逐行刷日志。
- 返回 Codex 原生聊天链接，可查看已保存的任务、工具过程和最终回复；标题使用具体执行任务。
- 默认在宿主机当前用户环境完整访问并启用 `web_search="live"`，普通派发不提供沙箱选择；用户明确要求隔离时须先在本地配置启用。支持多个项目独立注册、同工作树独立事项不限数量并行、同会话防重复执行和受控容量续跑。
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

每次派发同时提供用户原文 `user_request` 和规划建议 `prompt`，后续用户说明用 `user_followup` 逐字追加。Codex 先只读核查真实代码、日志和工具结果，返回审核依据与允许实施的范围；桥接核对本轮输入版本后，在同一原生会话自动发起执行，无需用户重复批准已授权事项。审核轮次和执行轮次分别保留输出及尝试记录，仍是同一个事项、同一个 job 和原生会话。

审核结果缺失、版本不符、没有成功核查记录、原文缺失或没有明确范围时，任务停在 `review_needs_evidence`；技术方案需修订时为 `review_revise`。规划端按原事项传 `review_followup={review_job_id, response}` 回应，并提供修订后的 `prompt`，新版本重新审核。若涉及用户目标、明确约束、验收或授权变化，仍须真实用户决定，通过既有 `plan_decision` 续接。执行中新证据推翻假设时也会退回审核，保留已完成部分。

`plan_review` 记录输入 SHA-256、执行者的依据、`allowed_scope` 和状态；它是协议门禁和执行者判断，不是操作系统沙箱，也不能证明依据内容一定正确。完整访问下的只读核查仍由 Codex 遵守；桥接发现审核中的文件变更事件会暂停，但不能识别所有 shell 命令的副作用。审核通过不代替测试、运行回读或业务验收。

| 工具 | 用途 |
| --- | --- |
| `codex_run` | 提交一个具体事项；默认后台返回，`wait=true` 只在明确要求等待时使用 |
| `codex_list` | 重启后按项目找回最近任务 |
| `codex_sessions` | 查看当前项目的原生会话摘要和聊天链接 |
| `codex_result` | 领取原回执，或查看最后已落盘进度；`sync_title=true` 可补齐已结束旧任务的标题 |
| `codex_wait` | 一次等待既有任务完成，不重新提交 |
| `codex_cancel` | 只取消该任务拥有的子进程，不回滚源码改动 |

`topic` 应是“修复播放器切集失败”这样的实际任务，而不是“Codex 执行者”。首次新事项的会话建立事件带有原生聊天链接，不必等到最终回执；常规进度、同事项续接和通知恢复只留本地，不反复唤醒模型或刷聊天。通知正文保留本地时间、项目/短事项、具体结果或所需操作和一个详情链接，默认最多三行；用户选择完整展示。把 `chat.vscode_uri` 展示给用户；`chat=null` 不代表失败，也不是重复提交的理由。

通知有持久化事件编号和独立投递状态。`accepted` 仅表示宿主 API 接受，不能冒充用户已看到；发送前已知失败为 `not_sent`，可有限退避和重启补送；结果不明为 `uncertain`，先核对原生收件记录，不盲目重发。`codex_list` / `codex_result` 的 `notification` 显示待投递、未知结果及通知进程状态。

同一工作树不设固定任务数上限，也不为独立任务排队。同一 `topic_id` / Codex 会话仍禁止同时启动两轮，避免同一事项被重复执行。强关联、重叠改动或前置依赖先问用户选择独立 worktree 还是等待；切分支本身不是共享目录的隔离。Git 暂存、提交和集成由协调者串行安排，文件归属靠派发范围和差异回读，不宣称操作系统级隔离。机器资源和上游服务限额仍客观存在。

`codex_list(active_only=true, cwd=当前项目)` 可列出全部活动任务；默认最近20项只是历史展示长度，不限制同时运行的数量。

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

可对已有任务做一次本地通知策略检查，不重新执行 Codex，也不在聊天中产生测试回执：

```pwsh
pwsh -NoProfile -Command 'node scripts/verify.cjs --config C:/path/to/mcp_config.json --notification-check --receipt JOB_ID'
```

回读该事件的本地投递记录，预期为 `suppressed`。它不唤醒聊天或模型，不展示内部编号，不代表真实聊天收发验收已通过。正常结果通知应说明具体完成内容、剩余事项或需要用户作出的选择，不能用状态、代号或“通知已收到”代替。

要在原 Antigravity 聊天中实际验收多个 Codex 并行，可把 `--notification-check` 换成 `--parallel-check`。它明确请求 Antigravity 连续提交三个独立只读项目核查；每个任务读取文件并短暂等待20秒，以观察执行区间重叠。三是本次验收样本数，不是运行上限。该模式会调用真实 Codex 和 Antigravity、消耗额度，不修改业务文件或提交代码。应先确认当前 MCP 已加载新版，再执行一次，保留事件和任务编号，不重复派发。

`--subagent-check` 则派发一次原生子 agent 验收：父 Codex 必须真正启动并等待子 agent 读取项目说明，返回原生子 agent ID；应核对实际 spawn/wait 事件，不只相信最终文字。注册名不同时可用 `--server NAME` 指定已有 MCP 服务。

## 边界

- 完整访问仍受当前系统账号、网络和上游服务权限约束；项目注册和串行锁不是安全沙箱。
- `completed` 只表示 CLI 正常结束，仍需核对命令、输出、测试和用户验收条件。
- 方案拒绝与执行策略受阻分开报告：`execution_blocked` 保留已确认方案，不表示方案失败，也不因后续诊断完成而解除。拒绝后不自动重试或换入口规避；同事项续接区分只读诊断、不受阻工作和正常授权/策略修复后的恢复，见[执行策略受阻](docs/configuration.md#执行策略受阻)。完整访问不取消内核命令检查，未知拒绝原因不能凭报错猜测。
- 精确的模型容量错误才会同模型、同会话续跑；脚本等待，不用模型轮询，不从头重放未知副作用。
- 运行记录不自动按年龄删除。未知文件、仍需续接的任务和唯一证据不能当缓存清理。
- 不上传凭证、私人工作区路径、任务日志、回执或安装回滚状态。见 [安全说明](SECURITY.md)。

依据：[Antigravity MCP](https://antigravity.google/docs/mcp)、[Hooks](https://antigravity.google/docs/hooks)、[Sidecars](https://antigravity.google/docs/sidecars)、[Rules](https://antigravity.google/docs/rules)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Codex 联网搜索](https://learn.chatgpt.com/docs/web-search)。
