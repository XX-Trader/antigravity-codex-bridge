# 项目说明

本项目是 Antigravity 与本机 Codex CLI 之间的 stdio MCP 桥接，不是某个业务项目。Windows、Node.js 22+、PowerShell 7；没有 npm 运行依赖。

## 代码与入口

- `src/server.cjs`：协议、任务 worker、持久化、权限、原生会话、标题与共享配额查询（`codex_quota`）。
- `src/model-policy.cjs`：执行档位、角色边界和本机账户模型快照校验。
- `src/routing-policy.cjs`：双引擎线性均衡、官方 `agy /usage` 五桶解析、增量转录索引、跨进程单飞共享缓存与单/双边耗尽交接裁决。
- `src/agy-guard.cjs`：AGY 先审后做门禁（Codex 100% 耗尽时自动免死锁）与智能防死循环熔断。
- `src/router.cjs`：多项目选择、会话归属及 `PreToolUse` / `PostToolUse` / `SessionStart` / `PreInvocation` 钩子路由。
- `src/notifier.cjs`：文件事件监听、一次性原生回执投递及宿主单例后台共享额度定时刷新（`startQuotaSyncLoop`）。
- `src/invoke-codex.ps1`：真实 Codex 启动与无引号 Windows 钩子入口；不改全局 Codex 配置。
- `scripts/Mode.ps1` / `scripts/mode.cjs`：免重启查看双引擎配额、切换模式、调整线性曲线/缓冲解锁窗口与模型池配置。
- `scripts/Setup.ps1` / `scripts/setup.cjs`：预览、合并安装和按字段回滚。
- `scripts/test.cjs`、`test/`：不调用模型的测试。
- `scripts/verify.cjs`：注册检查，以及显式启用的真实 Codex smoke。
- `.agents/rules/antigravity-codex.md`：Antigravity 编排规则的单一正文。

## 修改与验收

默认在当前目录维护，不按聊天创建 worktree。修改前核对 Git 状态和分支；公开仓库不得带入其它项目代码、账号信息、本机路径、配置、运行记录或历史。Codex 在本项目直接执行，不再次调用自身 MCP。

保持后台任务独立，同一工作树的独立事项不限数量并发；只禁止同一事项/会话同时执行重复轮次。强关联、重叠写入或依赖未完成时，先问用户选择独立 worktree 还是等待，不擅自隔离。共享 Git 暂存、提交、切分支与集成由协调者串行安排。取消只针对拥有的子进程，不能影响其它任务。协议 stdout 只写 JSONL；日志写 stderr 或外部运行目录。未知发送/执行结果不盲目重放。

维护本桥接仓库时，Antigravity 可以直接使用自己的工具修改代码、运行测试、提交并普通推送任务分支，无需交给 Codex MCP。不要为维护自身把本仓库登记到执行项目列表；本仓库排除业务编排规则，避免钩子要求递归派发。直接维护仍遵守用户授权、已有改动保护、测试和 Git 门禁；main 合并、部署及正式发布须有相应授权。

接入桥接的其它项目默认遵循本机双引擎自动均衡策略（`auto`：Codex 默认 5 天 100% 线性消耗并作为兜底引擎，AGY 主池与可选独立模型池默认 7 天 90% 线性上限、平时预留 10% 应急缓冲并在距周重置 ≤6 小时内自动解锁剩余 10% 缓冲，且叠加 5 小时窗口守卫；单边 100% 硬归零时自动解除粘性锁定执行跨端交接，双边受限时按软缓冲应急省流或双归零暂停交用户决定；依赖 Codex 原生 `spawn_agent` 或原生子会话契约的流水线及长后台任务在 Codex 未耗尽时固定留 Codex 执行；可随时切换为 `agy` 或 `codex`）。走 Codex 执行时，Antigravity 提出方案并验收，Codex 对新事项先独立只读核查，再按通过审核的版本与范围执行；同一事项后续方案续接原会话，由 Codex 结合上下文自行核查，不强制每轮独立审核。明确仅审核的任务仍保持只读。规划实现细节是建议，用户授权与审核边界内的技术错误由 Codex 自行纠正并验证；确实无法解决的技术阻塞才交回讨论，改变用户目标、明确约束、验收或授权须保留用户决定。锁定 `codex` 模式或已归属 Codex 的事项，Antigravity 不能使用自己的命令、写文件或子 agent 工具代替 Codex 执行；Codex 侧子任务须由 Codex 原生子 agent 完成，保留真实的 spawn/wait 与子 agent ID 证据，不把多条 CLI 会话叫作子 agent。禁止经本 MCP 递归调用自身不等于禁用 Codex 原生子 agent。走 AGY 执行时按低成本多子代理分层与同模块 `send_message` 复用保缓存推进，并遵守智能防死循环与先审后做门禁。

模型 ID、安装路径和存储盘符不能硬编码为某个人的环境。默认继承 Codex 模型；可选别名留在本机配置。完整访问与联网默认必须在 README 和安装确认中明示。

实施任务默认允许按需修改当前仓库内与目标相关的源码、测试、配置和文档，包括验证发现的关联缺陷；初始文件清单不作为禁改白名单。具体边界见 `.agents/rules/antigravity-codex.md` 的“仓库内修改范围”；仅审核、用户明确禁令、验收标准和已有无关改动仍受保护。

使用 `pwsh` / `pwsh.exe`，无 BOM UTF-8。测试前设置适合当前环境的外部 `CODEX_EXECUTOR_TEST_ROOT`；本机用户已有存储规范时从其规范。运行 `pwsh -NoProfile -Command 'npm test'` 和 `git diff --check`；涉及安装器时验证幂等、已有字段保留、符号链接与回滚冲突。

区分 mock 测试、真实 CLI、原生协议和 Antigravity 界面验收。没有实际观察就说明未验证，不把 CI 或 push 当成宿主已加载。本仓库目前没有 Graphify 索引，不引入其它业务仓库的索引或数据。
