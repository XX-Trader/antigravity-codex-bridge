# 项目说明

本项目是 Antigravity 与本机 Codex CLI 之间的 stdio MCP 桥接，不是某个业务项目。Windows、Node.js 22+、PowerShell 7；没有 npm 运行依赖。

## 代码与入口

- `src/server.cjs`：协议、任务 worker、持久化、权限、原生会话与标题。
- `src/router.cjs`：多项目选择、会话归属和 PreToolUse 身份绑定。
- `src/notifier.cjs`：文件事件监听、一次性原生回执投递。
- `src/invoke-codex.ps1`：真实 Codex 启动；不改全局 Codex 配置。
- `scripts/Setup.ps1` / `scripts/setup.cjs`：预览、合并安装和按字段回滚。
- `scripts/test.cjs`、`test/`：不调用模型的测试。
- `scripts/verify.cjs`：注册检查，以及显式启用的真实 Codex smoke。
- `.agents/rules/antigravity-codex.md`：Antigravity 编排规则的单一正文。

## 修改与验收

默认在当前目录维护，不按聊天创建 worktree。修改前核对 Git 状态和分支；公开仓库不得带入其它项目代码、账号信息、本机路径、配置、运行记录或历史。Codex 在本项目直接执行，不再次调用自身 MCP。

保持后台任务独立，同一工作树的独立事项不限数量并发；只禁止同一事项/会话同时执行重复轮次。强关联、重叠写入或依赖未完成时，先问用户选择独立 worktree 还是等待，不擅自隔离。共享 Git 暂存、提交、切分支与集成由协调者串行安排。取消只针对拥有的子进程，不能影响其它任务。协议 stdout 只写 JSONL；日志写 stderr 或外部运行目录。未知发送/执行结果不盲目重放。

Antigravity 只规划和验收，不能使用自己的命令、写文件或子 agent 工具代替 Codex 执行。子任务须由 Codex 原生子 agent 完成；保留真实的 spawn/wait 与子 agent ID 证据，不把多条 CLI 会话叫作子 agent。禁止经本 MCP 递归调用自身不等于禁用 Codex 原生子 agent。

模型 ID、安装路径和存储盘符不能硬编码为某个人的环境。默认继承 Codex 模型；可选别名留在本机配置。完整访问与联网默认必须在 README 和安装确认中明示。

使用 `pwsh` / `pwsh.exe`，无 BOM UTF-8。测试前设置适合当前环境的外部 `CODEX_EXECUTOR_TEST_ROOT`；本机用户已有存储规范时从其规范。运行 `pwsh -NoProfile -Command 'npm test'` 和 `git diff --check`；涉及安装器时验证幂等、已有字段保留、符号链接与回滚冲突。

区分 mock 测试、真实 CLI、原生协议和 Antigravity 界面验收。没有实际观察就说明未验证，不把 CI 或 push 当成宿主已加载。本仓库目前没有 Graphify 索引，不引入其它业务仓库的索引或数据。
