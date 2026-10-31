# 配置与恢复

## 安装器做什么

`pwsh -NoProfile -File scripts/Setup.ps1 --help` 查看参数。默认预览；只有 `--apply --trust-full-access` 才会写入配置。

默认配置位置：

- MCP：`~/.gemini/config/mcp_config.json`，也可用 `--config` 指定现有文件。文件是符号链接时更新真实目标，不覆盖链接。
- Hook：`~/.gemini/config/hooks.json` 的 `codex-executor-origin`，处理桥接工具、MCP 包装层及已知的宿主执行入口。
- 项目说明：项目的 `.agents/rules.json` 增加对本仓库 `.agents/rules/antigravity-codex.md` 的引用，保留已有 entries。维护本仓库自身时直接使用仓库内的规则，不重复引用。
- 可选通知：提供 `--agentapi` 后写入 `~/.gemini/config/sidecars/codex-executor/sidecar.json`，并在全局 `config.json` 启用同名 Sidecar。保留已有 projectId。

多次执行可以登记更多互不包含的项目根。相同项目复用原数据根，不能因一次聊天换掉旧数据目录。不会把所有项目默认指向第一个根；定向 hook 使用真实 workspacePaths 校验 cwd、任务归属与发起会话。

## 用户原文与规划摘要

`codex_run`（以及兼容入口 `codex_start` / `codex_continue`）把两者分开：`user_request` 保存用户原文，`prompt` 保存 Antigravity 的执行清单、事实与建议。同一事项/会话首次记录的原文不能替换；用户新的说明或批准用 `user_followup` 原样追加。省略原文字段的旧调用仍兼容，但明确标记 `not_provided`，绝不把 `prompt` 当作用户原话。旧任务之后补录的原文记录实际补录 job，不冒称首轮已有。

原文及补充保存在已有 `job.json` 的 `request_context`，新轮次继承最新上下文；启动脚本把原文、按顺序追加的说明和本轮摘要分别交给 Codex。回执只返回来源状态、原文 SHA256、首次记录 job 和补充条数；全文可按 `paths.job` 回读，避免通知重复发送长文本。每次原文/补充最多 60000 字符，合计最多 120000，超出明确拒绝，不截断。字段由调用方提供，桥接器不能独立认证文字确由用户输入，也不把“用户同意”或字段存在当作授权证明。

长需求、冲突或路线取舍先列出对应原句的必须做/禁止替代/验收/顺序，问一次整体确认；用户确认回复也原样传递。明确的小任务无需重复确认。后续实质改变目标、范围或标准时，再就一个阻塞点询问，不能自行选最省事的替代方案。

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

后台执行默认使用宿主机当前用户环境：`danger-full-access`、`approval_policy="never"`、`web_search="live"`，不自动提权，也不更改 Codex 全局配置。普通工具接口不提供 `sandbox` 参数；旧调用若传 `read-only` 或 `workspace-write`，后端和派发钩子会在执行前拒绝，不静默改变所请求的环境。只读、不重启、不改文件等约束写进 `prompt`，与执行环境分开。

真实调试使用问题实际发生的环境。本机进程、安装目录、监听端口和本地服务使用宿主机视图；不能根据沙箱内不可见就判断宿主机目标不存在。回执的 `execution_environment` 区分 `host` 与 `sandbox`，表示启动所用模式，实际可见性仍以运行证据为准。

只有用户明确要求隔离时，才在本地 MCP 服务的 `env` 中设置 `CODEX_EXECUTOR_ALLOW_SANDBOX="1"` 并刷新连接；工具列表随后提供 `sandbox` 选项。该开关由本地配置控制，工具参数不能开启；默认省略或设为 `"0"` 时拒绝沙箱派发。派发钩子从主服务配置读取同一策略，启用隔离时须保持服务与钩子配置一致。隔离任务完成后恢复 `"0"` 并刷新连接。

旧会话下一轮执行使用新的默认或本轮显式选择；正在运行的子进程不能热切换权限，不为改配置取消或重复派发。完整执行权限不改变业务目标，不授权网页中的指令，也不等于允许无关部署、资金操作或删除其它项目。

## 重连、日志与通知

用带 cwd 的 `codex_list` 找回 job，再领取 `codex_result`。正常完成通知依赖 Antigravity 为 Sidecar 提供 `ANTIGRAVITY_LS_ADDRESS`；不要猜地址、伪造会话 ID 或从普通终端冒充宿主。

每个任务在 `notifications/` 保存有序事件和对应 `.delivery.json`；进度与最终回执分开，带 `event_id`、`sequence`、原聊天和 Codex 查看入口。默认仅推送首次新事项的会话链接、终态及需要处理的异常；启动、文件变更、测试/构建/Git 阶段、容量重试、同事项续接与恢复只保存在本地，投递状态记 suppressed，不唤醒宿主或模型。超过两分钟的启动链接也静默处理，最终回执仍保留链接。终态优先；notification_check 也只做本地静默检查，不向聊天发“收到通知”或编号。显式并行/子 agent 验收仍按授权派发。

文件监听只是唤醒提示，不是唯一保障。通知器每15秒本地补查活跃/未确认任务，同时发现漏掉的新任务目录；已确认历史不反复读取。此过程不调用模型、Codex 或业务命令，不发检查心跳。`notification-health.json` 保存最近检查、发送与监听错误，回执不再仅以 PID 存活判断健康。监听报错或启动失败时，补查继续，并在下一次补查时尝试重新挂载监听；watch_online 区分监听与补查状态。

`notification-alerts.json` 只检查最终结果与需要核查的执行异常：超过60秒仍待投递、发送前失败重试耗尽、发送结果不明。常规进度不触发告警。告警按同聊天、同根因合并一次，不递归生成告警；恢复仅更新本地记录，由原结果补送体现恢复，不额外唤醒模型。通道本身坏了不能保证立即通知，先在本地和工具回执暴露。执行失败/超时/受阻沿用原终态通知，不再重复发送。真实通知唤醒 Antigravity 仍可能消耗 token，本地补查不消耗。

发送前调用原生会话元数据接口核对宿主。此时失败记 `not_sent`，最多按 2/10/30 秒退避重试，宿主重启后可恢复。调用发送接口后结果不明记 `uncertain`；只有原生 Sidecar 成功事件记录匹配收件人和事件编号时才自动确认，不靠“没有记录”推断未送达。无法确认时保留并通过回执暴露，禁止盲目重放。`accepted` 不是聊天渲染或业务完成证明。

通知进程按宿主连接与代码 build 生成代际标识，同一代只允许一个 owner，新代接管后旧版通知进程退出；单条事件另有跨进程 claim。遗留旧版进程不懂此协议，需要核实进程身份后单独退出通知进程，不能连带结束 Codex worker。运行中的旧 worker 可由新版通知器接管事件记录和最终回执，历史事项已续接时不再推送过时回执。

用户正文默认最多三行：本地事件时间 · 具体事项；具体完成内容、未完成项或所需操作；一个详情链接。仓库目录名、状态和编号不能代替实际内容。同日 HH:mm，跨日 MM-DD HH:mm；时间取事件发生时刻，明显延迟时标注延迟送达。内部控制与用户通知草稿分别标记，隐藏内部 ID、事件名和协议说明；终态草稿从原 result.txt 提取实际说明，仍须领取完整回执核验后再发送，不能把摘录直接当作验收通过。需要用户选择时完整保留问题和选项。单条命令成功不能推断全部门禁通过，同事项内部续接静默，最终验收后才报告结果。

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
