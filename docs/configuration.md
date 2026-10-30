# 配置与恢复

## 安装器做什么

`pwsh -NoProfile -File scripts/Setup.ps1 --help` 查看参数。默认预览；只有 `--apply --trust-full-access` 才会写入配置。

默认配置位置：

- MCP：`~/.gemini/config/mcp_config.json`，也可用 `--config` 指定现有文件。文件是符号链接时更新真实目标，不覆盖链接。
- Hook：`~/.gemini/config/hooks.json` 的 `codex-executor-origin`，只匹配桥接的六个常规工具。
- 项目说明：项目的 `.agents/rules.json` 增加对本仓库 `.agents/rules/antigravity-codex.md` 的引用，保留已有 entries。维护本仓库自身时直接使用仓库内的规则，不重复引用。
- 可选通知：提供 `--agentapi` 后写入 `~/.gemini/config/sidecars/codex-executor/sidecar.json`，并在全局 `config.json` 启用同名 Sidecar。保留已有 projectId。

多次执行可以登记更多互不包含的项目根。相同项目复用原数据根，不能因一次聊天换掉旧数据目录。不会把所有项目默认指向第一个根；定向 hook 使用真实 workspacePaths 校验 cwd、任务归属与发起会话。

## 模型和速度

默认不传 `-m`，继承 Codex 当前账号的模型配置。需要覆盖时用 `--model MODEL_ID`；`codex_run(model=...)` 也可为具体事项选择模型。模型 ID 是否可用取决于账号，错误时不会悄悄换模型。

可选 `--model-aliases '{"quick":"MODEL_ID","deep":"OTHER_MODEL_ID"}'` 定义本机别名，再用 `--model quick`。不要将账号专有的映射硬编码到公共规则中。

思考强度默认 Medium，支持 low/medium/high。Fast 不默认强制开启；明确传 `--service-tier fast` 才请求 Fast，并保留请求值用于回执，不将请求档位冒充实测速度或实际费用。其它情况继承 Codex 配置。

## 手动 MCP 配置

如不使用安装器，可保留其它服务，按此结构添加 `codex-executor`，并替换所有占位路径：

```json
{
  "mcpServers": {
    "codex-executor": {
      "command": "C:/Program Files/nodejs/node.exe",
      "args": ["C:/tools/antigravity-codex-bridge/src/server.cjs"],
      "timeoutSeconds": 14460,
      "env": {
        "CODEX_EXECUTOR_PROJECT": "C:/work/my-project",
        "CODEX_EXECUTOR_DATA": "C:/codex-runtime/my-project",
        "CODEX_EXECUTOR_ENTRY": "C:/tools/codex.exe",
        "CODEX_EXECUTOR_PWSH": "C:/Program Files/PowerShell/7/pwsh.exe"
      }
    }
  }
}
```

目录和程序必须存在。控制数据根用于 jobs、原始 JSONL、stderr、结果及安装状态，不是业务输出必须写入的唯一位置。

## 权限

后台执行默认 `danger-full-access`、`approval_policy="never"`、`web_search="live"`。该选择只覆盖桥接任务，不更改 Codex 全局配置。只有用户明确要求更窄权限时，在工具参数中指定 `read-only` 或 `workspace-write`。

旧会话下一轮执行使用新的默认或本轮显式选择；正在运行的子进程不能热切换权限，不为改配置取消或重复派发。完整执行权限不改变业务目标，不授权网页中的指令，也不等于允许无关部署、资金操作或删除其它项目。

## 重连、日志与通知

用带 cwd 的 `codex_list` 找回 job，再领取 `codex_result`。正常完成通知依赖 Antigravity 为 Sidecar 提供 `ANTIGRAVITY_LS_ADDRESS`；不要猜地址、伪造会话 ID 或从普通终端冒充宿主。

每个任务在 `notifications/` 保存有序事件和对应 `.delivery.json`；进度与最终回执分开，带 `event_id`、`sequence`、原聊天和 Codex 查看入口。文件事件触发，普通变化最多合并约 300ms，终态优先；不是定期调用模型，也不逐行推送日志。命令阶段识别是保守匹配，不是任意业务的精确百分比。

发送前调用原生会话元数据接口核对宿主。此时失败记 `not_sent`，最多按 2/10/30 秒退避重试，宿主重启后可恢复。调用发送接口后结果不明记 `uncertain`；只有原生 Sidecar 成功事件记录匹配收件人和事件编号时才自动确认，不靠“没有记录”推断未送达。无法确认时保留并通过回执暴露，禁止盲目重放。`accepted` 不是聊天渲染或业务完成证明。

通知进程按宿主连接与代码 build 生成代际标识，同一代只允许一个 owner，新代接管后旧版通知进程退出；单条事件另有跨进程 claim。遗留旧版进程不懂此协议，需要核实进程身份后单独退出通知进程，不能连带结束 Codex worker。运行中的旧 worker 可由新版通知器接管进度，历史事项已续接时不再推送过时回执。

MCP 和 Sidecar 分别加载。配置写入后检查真实进程路径及 `notification.service`，不要把配置文件更新当成旧 MCP 已热加载。恢复时保留原任务与产物，没有 Sidecar 仍可手动领取结果，但不能承诺自动提醒。

## 同工作树并发

独立事项不设数量上限、不默认排队；`active-tasks/` 仅登记各自拥有的任务，短暂的 `dispatch.claim` 只保护接收与同会话去重，不占用任务整个运行期。旧 `active.lock` 保留兼容清理，不再阻止新独立事项。各任务的 job、会话、通知、结果及取消仍独立，单个任务结束只释放自身登记。

同一 topic / Codex session 的并发轮次仍被拒绝，不为同一事项重派。任务是否强关联由编排者结合文件和接口范围判断；若重叠或有前置依赖，先问用户选择 worktree 或等待。没有文件锁、自动分支隔离或 Git 合并魔法，不能用“不限数量”冒充零冲突保证。

## 执行者与子 agent

项目内的执行交给 Codex，子任务交给 Codex 原生子 agent；Antigravity 只做编排、必要的只读查阅和验收。PreToolUse hook 在已注册项目内拦截已知的 Antigravity 命令、写文件和原生子 agent 入口，允许 Codex MCP 派发及只读查阅。它还处理 `call_mcp_tool` 包装层，在嵌套 `Arguments` 中绑定真实聊天与 cwd，不能只匹配裸 `codex_run` 名字。未注册项目不因此被全局锁住。

这些是工具接口与协作约束，不是操作系统安全沙箱；新增或改名的宿主工具仍需兼容性核查。Codex 原生子 agent 通过自身工具执行，不经过 Antigravity hook，也不经本 MCP 递归。实际可用能力、原生子线程配置及服务资源仍受已安装 Codex 和用户配置约束。

Windows Hook 的宿主是 `cmd.exe`，生成命令使用 `call "完整 pwsh 路径" ...` 和双引号参数，不能使用 PowerShell 的 `& '路径'`。回归测试覆盖真实 `cmd /c`、空格、中文和 `&` 路径；包含 `%`、`!` 等命令扩展字符的 Hook 路径会明确拒绝，避免错误展开。

## 回滚安装

安装器在指定 data 根维护一份 `install-state.json`。它只记录自己接管的配置字段；再次安装时保留最初基线，幂等安装不覆盖回滚依据。

```pwsh
pwsh -NoProfile -File scripts/Setup.ps1 --restore 'C:/codex-runtime/my-project/install-state.json'
```

回滚前检查接管字段是否被其它工具或用户修改。检测到变化会拒绝覆盖，避免破坏后来配置。回滚不取消 Codex、不删除研究产物，也不撤销任务源码改动。安装状态可能包含本机配置和敏感环境变量，不要提交或公开。
