# 配置与恢复

## 安装器做什么

`pwsh -NoProfile -File scripts/Setup.ps1 --help` 查看参数。默认预览；只有 `--apply --trust-full-access` 才会写入配置。

默认配置位置：

- MCP：`~/.gemini/config/mcp_config.json`，也可用 `--config` 指定现有文件。文件是符号链接时更新真实目标，不覆盖链接。
- Hook：`~/.gemini/config/hooks.json` 的 `codex-executor-origin`，处理桥接工具、MCP 包装层及已知的宿主执行入口。
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

文件监听只是唤醒提示，不是唯一保障。通知器每15秒本地补查活跃/未确认任务，同时发现漏掉的新任务目录；已确认历史不反复读取。此过程不调用模型、Codex 或业务命令，不发检查心跳。`notification-health.json` 保存最近检查、发送与监听错误，回执不再仅以 PID 存活判断健康。

`notification-alerts.json` 合并同聊天、同根因的通知异常：超过60秒仍待投递、发送前失败重试耗尽、发送结果不明。告警自身不递归生成告警；同一异常首次通知一次，已送达的告警恢复后通知一次。告警尚未发出就恢复时只更新本地记录，避免补发过时告警。通道本身坏了不能保证立即通知，先在本地和工具回执暴露。执行失败/超时/受阻沿用原终态通知，不再重复发送。真实通知唤醒 Antigravity 仍可能消耗 token，本地补查不消耗。

发送前调用原生会话元数据接口核对宿主。此时失败记 `not_sent`，最多按 2/10/30 秒退避重试，宿主重启后可恢复。调用发送接口后结果不明记 `uncertain`；只有原生 Sidecar 成功事件记录匹配收件人和事件编号时才自动确认，不靠“没有记录”推断未送达。无法确认时保留并通过回执暴露，禁止盲目重放。`accepted` 不是聊天渲染或业务完成证明。

通知进程按宿主连接与代码 build 生成代际标识，同一代只允许一个 owner，新代接管后旧版通知进程退出；单条事件另有跨进程 claim。遗留旧版进程不懂此协议，需要核实进程身份后单独退出通知进程，不能连带结束 Codex worker。运行中的旧 worker 可由新版通知器接管进度，历史事项已续接时不再推送过时回执。

MCP 和 Sidecar 分别加载。配置写入后检查真实进程路径及 `notification.service`，不要把配置文件更新当成旧 MCP 已热加载。恢复时保留原任务与产物，没有 Sidecar 仍可手动领取结果，但不能承诺自动提醒。

## 同工作树并发

独立事项不设数量上限、不默认排队；`active-tasks/` 仅登记各自拥有的任务，短暂的 `dispatch.claim` 只保护接收与同会话去重，不占用任务整个运行期。旧 `active.lock` 保留兼容清理，不再阻止新独立事项。各任务的 job、会话、通知、结果及取消仍独立，单个任务结束只释放自身登记。

同一 topic / Codex session 的并发轮次仍被拒绝，不为同一事项重派。任务是否强关联由编排者结合文件和接口范围判断；若重叠或有前置依赖，先问用户选择 worktree 或等待。没有文件锁、自动分支隔离或 Git 合并魔法，不能用“不限数量”冒充零冲突保证。

## 执行者与子 agent

项目内的执行交给 Codex，子任务交给 Codex 原生子 agent；Antigravity 只做编排、必要的只读查阅和验收。PreToolUse hook 在已注册项目内拦截已知的 Antigravity 命令、写文件和原生子 agent 入口，允许 Codex MCP 派发及只读查阅。它还处理 `call_mcp_tool` 包装层，在嵌套 `Arguments` 中绑定真实聊天与 cwd，不能只匹配裸 `codex_run` 名字。未注册项目不因此被全局锁住。

这些是工具接口与协作约束，不是操作系统安全沙箱；新增或改名的宿主工具仍需兼容性核查。Codex 原生子 agent 通过自身工具执行，不经过 Antigravity hook，也不经本 MCP 递归。实际可用能力、原生子线程配置及服务资源仍受已安装 Codex 和用户配置约束。

桥接使用非交互 `exec`，不是原生交互式选择框代理。Codex 需要用户选择时，结束该轮并输出 `[CODEX_NEEDS_INPUT]`，随后给出包含 `question`、字符串数组 `options`、可选 `recommendation` 和 `completed` 的 JSON；旧式纯文本仍保留。回执和终态通知保存、展示问题，等待用户回答后用原 topic/session 续接，不自动选择或重新开始。`[CODEX_BLOCKED]` 同样保留具体阻塞原因。

`completed` 仅表示 CLI 轮次结束。若命令只有 started、没有 completed，或 Codex 明确报告 `[CODEX_BACKGROUND_RUNNING]`，回执标记 `execution_state=background_unconfirmed`、`verification_state=pending`，保存已观测的未确认命令。它不证明进程仍活着，也不证明测试失败；由 Antigravity 结合原日志/session 判断下一步，不能把未知退出当作通过。

Windows Hook 经宿主参数转义后交给 `cmd.exe /c`。生成的 `command` 值完全不含单双引号，不能使用 PowerShell 的 `& '路径'`，也不能依赖 `call "路径"` 绕过宿主转义。命令只带 pwsh、脚本及 MCP 配置路径；Node 路径由脚本内部读取 MCP 配置，未配置时才查找 PATH，显式 `-NodeEntry` 仍适用于直接调用和 Sidecar。

Hook 路径含空格或 `&` 时，安装器尝试现有路径的 8.3 短名；短名不可用或含不支持的命令字符时，在写配置前明确失败，请改用不含空格和元字符的安装路径。不会静默换程序或生成仍带引号的命令。回归测试覆盖普通 argv 转义、原样 `cmd /c` 和 shell 调用，以及中文 JSON 与带空格的 Node 配置路径。

## 回滚安装

安装器在指定 data 根维护一份 `install-state.json`。它只记录自己接管的配置字段；再次安装时保留最初基线，幂等安装不覆盖回滚依据。

```pwsh
pwsh -NoProfile -File scripts/Setup.ps1 --restore 'C:/codex-runtime/my-project/install-state.json'
```

回滚前检查接管字段是否被其它工具或用户修改。检测到变化会拒绝覆盖，避免破坏后来配置。回滚不取消 Codex、不删除研究产物，也不撤销任务源码改动。安装状态可能包含本机配置和敏感环境变量，不要提交或公开。
