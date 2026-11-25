# 配置与恢复

## 执行分工与用量口径

本仓库的 `.agents/rules.json` 排除 `antigravity-codex.md`，避免开发桥接器自身时自动套用强制委派规则；规则正文仍留在原位，供其他项目引用。本机若已将桥接器源码根登记为执行项目，还需从两个 MCP 服务及 Sidecar 的项目列表中移除该根，并通过安装器同步回滚记录；仅隐藏规则不会解除 PreToolUse 的执行限制。已有对话和连接是否加载新配置须单独核验。

方案、根因、接口和验收明确的代码修复、补测试或执行验证可直接选择本机 `standard` 档位。复杂未知由主线程定位定案；需要原生子代理时，先冻结契约和文件边界，再以本机可用的标准执行模型处理独立子包。小任务和强耦合修改不强拆，用户明确指定的模型分工仍优先。已有收口产物的跨阶段新事项传递最小交接；未完成事项继续原会话，不以新开会话绕过门禁。

CLI 的 `turn.completed.usage` 是会话累计快照，resume 会包含原会话历史。新记录的 `usage` 保持数字对象兼容，但按原生 thread 只取最新快照；`usage_scope=session_cumulative` 表示它不是本任务新增用量。`usage_delta` 仅在已知起始基线时返回数字对象；继承旧会话、缺少身份、旧统计迁入或计数回退时返回 `null`。原始快照保留在 attempts 中，`usage_accounting` 保存会话身份、基线与恢复状态；旧记录未迁移，回读标记 `legacy_unverified`，不得作为准确消耗或计费凭据。读取不遍历原生会话历史，更新只处理当前快照和本任务涉及的会话，不新增后台扫描或缓存。

本机子代理默认模型属于用户配置，不写入桥接的通用规则。配置前用实际 CLI 验证支持的字段，备份后再修改；配置可解析不代表当前宿主已加载，也不证明真实子代理选型。MCP 构建同步须先核对活动任务及自动重载影响，保留项目登记、hooks 和安装回滚依据；不能证明安全窗口时暂缓同步，不能重启其他任务取得窗口。

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

## 待办、验收与方案拒绝

用户默认确认结果导向的待办、已约定的方法/限制与必要取舍；文件名、函数、库和测试命令留在内部执行清单与原始证据中，需要时再展开。Antigravity 提供验收标准并核对结果，Codex 自己实现、补测试和执行，不默认增加专门审核 agent。测试按风险覆盖正常、异常、边界、恢复、组合回归及必要的性能/资源场景；通过、失败、跳过、未测分别报告，不以 mock 或局部单测冒充业务验收。

Codex 明确拒绝方案时输出 `[CODEX_PLAN_REJECTED]` 及 JSON：`original_plan`、`reason`、`impact`、`question`、`options`、`completed`。桥接保存为 `blocked`，`handoff.requires_user_decision=true`；新解析的旧式 `[CODEX_BLOCKED]` 也保守采用此门禁，`[CODEX_NEEDS_INPUT]` 可用 `decision_scope="plan"` 标注方案选择。普通可修复实现错误不使用这些拒绝标记。无标记的普通结果不会靠关键词猜测为方案拒绝；完整原文仍保存在 `result.txt`，结构化通知字段只作有限长度摘录。

同一 topic/session 再派发前会检查未解决拒绝；未交回用户决定则返回 `[CODEX_USER_DECISION_REQUIRED]`，不创建任务。用户答复后按原会话提交 `plan_decision: {"refusal_job_id":"<原拒绝任务ID>"}`，同时把用户答复逐字放入 `user_followup`。只改写 `prompt`、仅声称“已获授权”、从旧 parent 或原生 session 续接都不能省略这一步。决定保存在新 job，旧拒绝回执不覆盖；其它独立事项不受阻。旧版已保存但未带门禁标记的回执不追溯冻结。

通知区分执行端拒绝与 Antigravity 建议，要求向用户讲清原计划、理由、影响和一个选择，不能静默换方案。未得到对应决定的拒绝通知不会仅因出现后续任务被自动抹掉；送达仍受原有 outbox/通道健康机制约束，不保证宿主界面一定展示。

这是防遗漏和错误续接的协作门禁，不是人类身份认证：桥接不能验证调用方提交的答复是否真的来自用户，也不能识别完全新建的无关联 topic 是否故意重复同一业务。Antigravity 必须如实转交原话，不另开事项绕过门禁。

## 执行策略受阻

执行端以 `[CODEX_EXECUTION_BLOCKED]` 加 JSON 报告：`blocked_action`、`reason`、`known_facts`、`unknowns`、`affected_checks`、`evidence`、`completed`。兼容结构化的 `[CODEX_NEEDS_INPUT]` / `[CODEX_BLOCKED]` 中 `blocker_type="execution_policy"`，但不把任意正文中的拒绝关键词自动当成策略证据。独立的 `[CODEX_PLAN_REJECTED]` 仍是方案选择，不能用类别字段把它改成普通执行问题。

桥接保存独立的 `execution_block`；终态为 `execution_blocked`、`verification_state=blocked`，没有未确认后台命令时 `execution_state=policy_blocked`。它不代表方案失败或业务验收通过。明确的 CLI router stderr（带时间戳与原生工具错误前缀）即使与 CLI 正常结束并存也会保留为机器观察的执行拒绝；普通命令 stdout、引用的报错和不相关错误不触发。结构化报告标记来源为 `executor_report`；两种来源都不自动确认具体根因，`reported_cause` 仅是执行端提出的解释。完整原文留在原结果、事件和 stderr 文件中；回执字段为有限长度摘录。旧 JSON 后附说明及已完成项数组均能读取。

策略受阻通知不要求用户重新选择已确认方案，说明受阻操作、事实/未知与受影响验收；方案拒绝另行保留。通知和拒绝记录不会仅因后续诊断任务出现而被静默清除。现有15秒本地补查、去重、不盲目重放和零模型轮询保持不变。

同一事项/会话的普通续接被 `[CODEX_EXECUTION_POLICY_UNRESOLVED]` 拦住。调用方须用 `execution_followup` 显式引用所有未解决的 `blocked_job_ids`，并声明 `intent`：

- `diagnose`：只读、无副作用核查，原拒绝保持未解决。
- `continue_unblocked`：只做不依赖受阻动作的已授权工作，不执行原动作或等价替代，原拒绝保持未解决。
- `resume_after_resolution`：先有正常授权或策略修复，再提供 `resolution: {"kind":"formal_approval 或 policy_fix","evidence":"实际审批/修复证据及位置"}`。记录为调用方声明，不授予任何操作权限；当前工具限制仍优先，不能据此绕过拒绝。

新任务的执行提示会收到持久化的续接模式和未解决约束。诊断或不相关工作完成不等于原任务全部完成；通过摘要、旧 parent 或原生 session 续接仍要检查这些记录。未关联的新事项不受数字并发限制，但不得伪造新事项绕过同一业务的拒绝。旧回执不追溯改写为新状态。桥接不独立认证审批真实性，不改变 Codex 内核、系统安全规则或全局权限，不启动被拒绝的程序做“自动修复”。

错误反馈不受正常完成通知的三行限制：用户正文包含受阻操作、原始错误短摘、已完成与受影响部分、当前是否暂停、下一步及是否需要用户处理。先向用户反馈，再开展后续诊断；详细日志仍保留在原回执，不默认倾倒整个 JSON。普通可修复过程错误和网络重连不逐次唤醒模型。

worker 先保存终态再释放事项登记；状态更新与崩溃恢复共用短 claim，恢复前重读当前状态。worker 异常退出时优先保留已有的拒绝/选择回执和原始 stderr，不以通用退出提示覆盖。仅对完全匹配的旧客户端覆盖签名，且存在同事项、同聊天的原始受阻终态事件时恢复状态；保留恢复来源，不改写或重发已经 accepted 的事件。

源码与配置更新不等于存量 MCP 进程已加载。新增状态后仍运行旧连接可能误判终态；必须刷新两个 MCP 连接和 Sidecar，再验证工具与回执。发送端 accepted 只表示宿主接收，不是聊天渲染或用户已读证明；没有宿主展示回执时不能承诺端到端送达，不以重发或模型轮询替代验证。

## 模型和速度

默认不传 `-m`，继承 Codex 当前账号的模型配置。需要覆盖时用 `--model MODEL_ID`；`codex_run(model=...)` 也可为具体事项选择模型。模型 ID 是否可用取决于账号，错误时不会悄悄换模型。

可选 `--model-aliases '{"quick":"MODEL_ID","deep":"OTHER_MODEL_ID"}'` 定义本机别名，再用 `--model quick`。不要将账号专有的映射硬编码到公共规则中。

思考强度默认 Medium，支持 low/medium/high。所有审核、执行与续接统一使用普通模式：启动层始终传入 `service_tier="default"` 和 `features.fast_mode=false`，覆盖 Codex 全局 Fast 设置。安装器将旧的 Fast 配置归一为 default；旧 `--service-tier fast` 参数仅兼容解析，不再开启 Fast。

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

后台执行默认使用宿主机当前用户环境：`danger-full-access`、`approval_policy="on-request"`、`approvals_reviewer="auto_review"`、`web_search="live"`，不自动提权，也不更改 Codex 全局配置。非交互执行中，符合条件的审批请求由自动审核处理；已有权限的操作不会因此全部触发审批。被策略拒绝时保留原始证据并按 `execution_blocked` 交接，不绕过拒绝。普通工具接口不提供 `sandbox` 参数；旧调用若传 `read-only` 或 `workspace-write`，后端和派发钩子会在执行前拒绝，不静默改变所请求的环境。只读、不重启、不改文件等约束写进 `prompt`，与执行环境分开。

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

### 超时与通知离线的排查

新任务省略 `timeout_seconds` 或设为 `0` 时没有累计执行时限；设为不小于 30 的整数时使用所选秒数，最大值为 2147483647。容量等待不计入执行时限，已保存任务的正数时限继续生效。上面 MCP 配置的 `timeoutSeconds` 控制宿主单次请求等待，与后台任务执行时限无关；`wait=false` 的后台任务独立运行。执行时限耗尽时，worker 请求终止自己拥有的进程树；这不证明所有后代进程都已退出。超时回执保留时限、`stop_reason`、终止请求状态、最近落盘进度和未确认命令；旧记录没有终止信息时返回未知，不能反推为未请求终止。最近进度不是最终结果。自动循环达到上限时仍进入人工接管。

执行提示说明本轮是否设置时限，并要求按需检索。已确定需要用户决定或存在无法解决的阻塞时，可选检索和索引刷新不能拖延阻塞反馈；必需证据及验收门禁保持不变。该提示不保证任意研究计算提速，也不自动重跑任务。

通知服务离线时，工具回复直接提示无法保证自动提醒。若 Sidecar 已注册却没有健康记录，检查宿主为它管理的数据目录及符号链接目标是否可达；修复路径后，仍需在宿主重新加载通知组件并回读健康及投递记录。不要凭联接修复或进程启动宣称通知已送达，也不要为验证通知重派业务任务。

本批修复记录（2026-11-09，UTC+8）：补齐超时诊断、检索等待提示和离线回执，保留原超时及人工接管规则。新增分支定向测试 5 项、失败用例及末段补验 17 项、安装器测试 9 项通过，补丁格式检查通过；单次完整 `npm test` 曾有一项后台协议用例超过 30 秒，随后达到 20 分钟总时限。该用例在不放宽时限的补验中通过，当时的完整命令仍记录为未通过，不用分项结果覆盖。当时补丁保留在任务分支，未提交、推送或合并 main，等待完整测试；后续验证与交付以当前提交及验收记录为准。未将本机配置、研究记录或通知数据纳入仓库。宿主加载及真实聊天显示须单独验收。

## 执行档位与模型边界

设置 `CODEX_EXECUTOR_EXECUTION_MODELS` 为 JSON 对象，必须包含 simple、standard、complex 三个执行档位，可额外配置 expert 处理极难问题；值为本机别名或模型 ID；默认模型须与 standard 一致。同时设置 general/quant 两个审核模型。模型 ID 留在本机配置，项目代码不固定个人型号。调用方用 `execution_tier` 选择任务难度，默认 standard；明确请求未配置的 expert 时直接报配置错误，不回落到其它档位；同事项续接省略档位保留原模型，切换已选模型须带真实 user_followup。旧 model 参数仅接受执行档位映射内的模型，且不得与显式档位冲突；工具定义也列出允许值，审核与执行分别按各自映射校验；通过 `CODEX_EXECUTOR_REVIEW_ONLY_MODELS`（模型 ID 或别名的 JSON 数组）指定仅审核模型。名单内模型只能作为审核角色，不能通过档位、旧 model 参数、继承或保存的旧任务进入执行；报模型配置错误，不自动换型号。

可设 `CODEX_EXECUTOR_MODELS_CACHE` 指向当前账户的绝对路径模型缓存（models[].slug）。派发前检查所选模型在该快照中；缺失、不可读或服务端仍报告 model_not_found 时明确报模型配置错误，不静默替代。缓存是本机快照，不保证服务端实时可用。未配置执行档位的其它安装保留原来的默认继承行为。

新派发的越界参数在创建 job 前拒绝；旧连接派发的新 worker 也会按同安装、同注册项目的当前角色配置，在启动 CLI 前复核，不热切换运行中的任务。启动前的模型错误记为 configuration_error，保留原用户决定和执行策略边界；CLI 在任何业务工具执行前返回明确 model_not_found 时也单独归类，不计业务失败或无进展轮次，不清空此前累计失败。修正参数后沿原事项续接，不自动重跑，不改历史回执。刷新 MCP 和规则后使用新的档位字段。

`CODEX_EXECUTOR_NORMAL_MODE_MODELS` 仍兼容解析，普通模式现已对所有模型强制生效，无需逐个列出。仅审核名单中的模型在审核阶段还强制使用 CLI `read-only` 沙箱，执行阶段在启动前拒绝；不能用完整访问配置放宽。审核意见仍需实际证据，沙箱不能代替业务审核。

只审核任务不再向后续执行传递执行模型；用户明确要求实施后，执行恢复本机默认档位或用户明确选择的合法执行模型。真实执行任务已保存的禁用模型不会静默替换，须带真实 `user_followup` 显式切换。派发和 worker 读取同安装、同项目的当前角色策略；不会修改正在运行的 CLI 进程。配置更新后仍需在宿主刷新 MCP，以更新工具定义和已加载入口。

## 首轮审核与会话续接

实施时按需修复仓库内与目标相关的源码、测试、配置和文档，初始文件清单不作为禁改白名单。关联检查发现真实缺陷时修复并重跑原检查；保护已有无关改动，保留仅审核、用户明确禁令与验收标准。派发与审核的具体边界见[仓库内修改范围](../.agents/rules/antigravity-codex.md#仓库内修改范围)。这不解除现有任务中的用户禁令，也不增加沙箱写权限；已安装副本和宿主已加载的规则须另行同步、核验。

规划端提供目标、用户硬约束、事实与假设、可调整的实现建议和业务验收要求；函数调用、线程/锁顺序及伪代码不自动成为用户指定方法。首轮审核仍只读，可记录有实际依据的技术修正和 allowed_scope 后通过；执行阶段在用户授权与审核边界内自行纠正并验证技术方案，不仅因规划建议写错就退回。关键证据无法自行取得、没有可行修正或需要改变用户明确边界时才交回讨论。用户限制、权限拒绝、失败接管和既有合理检查保持，失败证据不能因调整实现而删除。

新事项首轮独立审核；同一事项且同一原生会话已有真实审核记录时，后续方案直接续接，由 Codex 自行核查，不额外启动独立审核轮次。`context_review` 引用历史任务、原生会话和审核依据，`plan_review.status=context` 与 approved 分开，不把历史通过当成新版本已经通过。换事项、换会话或缺少真实审核上下文仍走首轮审核；调用方不能自行注入上下文批准。普通续接可直接传修订后的 prompt，review_followup 可选；用户决定、执行策略和失败接管门禁保持。

审核模型与执行模型独立。`CODEX_EXECUTOR_REVIEW_MODEL` 设置日常审核模型，`CODEX_EXECUTOR_QUANT_REVIEW_MODEL` 设置量化审核模型，均接受本机别名；未设置时继承执行模型，不在代码中固定个人模型 ID。项目条目可设 `review_category: "quant"`，普通项目默认为 `general`。调用时可显式传 `review_category`；未指定时结合项目、原事项和量化/回测/因子等任务内容判断。量化事项按项目类别、实际任务内容或显式分类续接；“量化数据/指标/结果”等普通性能测量措辞不单独触发量化审核。历史启发式分类会结合原文与内容复核，误判不永久继承；明确指定 quant 的分类仍保留。容量不足仍等待原审核模型，不自动切回其他模型。`model` 保留执行模型，实际审核选择见 `review_route`，两阶段的尝试记录保存各自实际模型。

用户单独交方案要求审核时，调用 `codex_run` 并设 `review_only=true`。审核通过后返回 `stage=review_complete`、`execution_state=review_only`，不会启动执行阶段。审核修订仍沿原事项续接并保留只审核模式。用户明确要求实施后，以逐字 `user_followup` 加 `review_only=false` 续接，在原会话结合上下文核查后实施；只在规划摘要中写“现在执行”不能解除该边界。审核模型、类别和只审核模式也绑定到方案版本中。

新 worker 也兼容旧连接的派发：缺少审核路由时，按 `CODEX_EXECUTOR_REVIEW_CONFIG`（旧注册使用默认 MCP 配置路径）回读同一安装、同一注册项目的当前审核策略，只更新审核模型与类别，不导入执行模型、CLI 或权限。待启动的旧连接任务若保留同事项、同会话的真实审核上下文，新 worker 会转为上下文续接；正在执行的阶段不热切换。旧 MCP 进程仍可能在派发前要求 review_followup，需刷新 MCP 连接并重新加载规则，才能完整使用可选修订字段和新的编排说明。

自动修订有上限：同一未完成事项自上次可核验进展后失败 3 轮，或连续 3 个执行轮次无可核验进展，worker 保存 `needs_input` / `handoff.blocker_type=human_takeover`，不再调用模型实施。历史 job 是计数依据，重启、换方案、审核通过及 CLI 退出 0 不清零；有真实证据的进展或验收完成自动清零。旧客户端派发也经过新 worker 的入口检查。

执行结果末尾的 `[CODEX_EXECUTION_REPORT]` 报告 `outcome`、原因、剩余验收与证据。桥接核对同一 job 执行阶段的成功命令和托管后台成功输出；缺失或不匹配视为无可核验进展。正常完成且证据匹配的 `progress` 清零计数；只有 `accepted`、无剩余验收且 CLI 正常完成才标记 `accepted_with_evidence`。这仍是执行者的判断，不是对业务正确性的独立证明。容量等待、取消和策略拒绝不作为普通修订失败；用户实际回答接管问题后，以原 `plan_decision` 和逐字 `user_followup` 重置循环并续接核查，不清除执行策略拒绝。

接管回执要求先解释失败根因、证据与未知项，给出最合适的解决建议，再请用户决定。历史审核终态若被旧客户端覆盖为固定的通用 worker 错误，仅在保存的审核结果与原终态通知身份一致时恢复，不重发已受理通知。

Sidecar 不再按四小时生成静默提醒；历史 `silence_alert` 不会再次发送，发送结果未知的事件仍需回执对账。终态通知和投递异常告警继续保留。

`codex_run`、`codex_start` 和同事项续接都从 `stage=review` 开始。用户原文与后续补充单独保存，`prompt` 承载规划端方案、证据来源和验收建议。审核只读，由同一个 Codex 执行者完成，不额外启动审核 agent；缺少原文时仍可受理旧调用，但不能通过审核进入实施。

审核最终返回 `[CODEX_REVIEW_APPROVED]`、`[CODEX_REVIEW_REVISE]` 或 `[CODEX_REVIEW_NEEDS_EVIDENCE]` 及 JSON。所有审核回执须原样带回 `plan_sha256`；通过结果还须有非空 `evidence`、`allowed_scope` 和成功工具核查记录。输入版本绑定本任务、cwd、环境、方案、用户原文与后续补充、审核答复及执行策略约束，调用方不能通过参数自行批准。审核阶段出现文件变更事件时暂停；回执缺失、无效、版本不符或后台核查命令退出未确认时不启动执行。

通过后桥接在同一 job、同一原生会话自动续接 `stage=execute`，将审核范围交给执行者；不要求用户再次批准已授权工作。审核输出为 `review-attempt-N.result.txt`，执行输出为 `attempt-N.result.txt`；审核尝试保存在 `plan_review.attempts`，执行尝试仍在 `attempts`，usage 包含两阶段。最终回执、列表和终态通知保留审核结果。同事项后续方案按上文复用原会话上下文自行核查，不重复独立审核；历史批准仍不能冒充新版本通过。

技术问题用 `decision_scope=technical`，任务结束为 `review_revise` 或 `review_needs_evidence`。规划端领取回执后，按原 topic/session 发回修订方案。下例的 review_followup 在普通上下文续接时可省略，仅审核模式或缺少可复用上下文时须提供：

```json
{
  "topic_id": "原事项编号",
  "prompt": "修订方案、补充依据及原验收条件",
  "review_followup": {
    "review_job_id": "未解决的技术审核任务编号",
    "response": "逐项回应审核发现的问题，说明修订和补证"
  }
}
```

修订仍需由 Codex 审核，规划端的同意不构成批准。改变用户目标、明确约束、验收或授权时使用 `decision_scope=user`，保留问题和选项，等待真实用户答复，再通过 `plan_decision` 和逐字 `user_followup` 续接。旧方案拒绝与执行策略门禁继续保留；技术重审不能清除策略拒绝。

执行中发现关键假设失效时返回 `[CODEX_REVIEW_REVISE]`，说明原因、证据、已完成部分和决定归属；暂停受影响操作，保留已有工作，修订后重审。审核通过仍是执行者基于有限证据的判断，不能证明内容正确或业务已完成。完整访问下的只读限制由执行者遵守，协议不具备操作系统写隔离，也不能识别全部 shell 副作用。

## 同工作树并发

独立事项不设数量上限、不默认排队；`active-tasks/` 仅登记各自拥有的任务，短暂的 `dispatch.claim` 只保护接收与同会话去重，不占用任务整个运行期。旧 `active.lock` 保留兼容清理，不再阻止新独立事项。各任务的 job、会话、通知、结果及取消仍独立，单个任务结束只释放自身登记。

同一 topic / Codex session 的并发轮次仍被拒绝，不为同一事项重派。任务是否强关联由编排者结合文件和接口范围判断；若重叠或有前置依赖，先问用户选择 worktree 或等待。没有文件锁、自动分支隔离或 Git 合并魔法，不能用“不限数量”冒充零冲突保证。

## 执行者与子 agent

项目内的执行交给 Codex，子任务交给 Codex 原生子 agent；Antigravity 只做编排、必要的只读查阅和验收。PreToolUse hook 在已注册项目内拦截已知的 Antigravity 命令、写文件和原生子 agent 入口，允许 Codex MCP 派发及只读查阅。它还处理 `call_mcp_tool` 包装层，在嵌套 `Arguments` 中绑定真实聊天与 cwd，不能只匹配裸 `codex_run` 名字。未注册项目不因此被全局锁住。

这些是工具接口与协作约束，不是操作系统安全沙箱；新增或改名的宿主工具仍需兼容性核查。Codex 原生子 agent 通过自身工具执行，不经过 Antigravity hook，也不经本 MCP 递归。实际可用能力、原生子线程配置及服务资源仍受已安装 Codex 和用户配置约束。

桥接使用非交互 `exec`，不是原生交互式选择框代理。Codex 需要用户选择时，结束该轮并输出 `[CODEX_NEEDS_INPUT]`，随后给出包含 `question`、字符串数组 `options`、可选 `recommendation` 和 `completed` 的 JSON；旧式纯文本仍保留。回执和终态通知保存、展示问题，等待用户回答后用原 topic/session 续接，不自动选择或重新开始。`[CODEX_BLOCKED]` 同样保留具体阻塞原因。

`completed` 仅表示 CLI 轮次结束。若命令只有 started、没有 completed，或 Codex 明确报告 `[CODEX_BACKGROUND_RUNNING]`，回执标记 `execution_state=background_unconfirmed`、`verification_state=pending`，保存已观测的未确认命令。它不证明进程仍活着，也不证明测试失败；由 Antigravity 结合原日志/session 判断下一步，不能把未知退出当作通过。

### 长命令本地托管

耗时不确定的测试、构建、Python 回测和数据处理使用受控托管，不要求用户或模型猜时间。Codex 在当前任务的 `background` 目录写 JSON 请求（`executable` 为解释器或程序绝对路径，`args` 为原样参数数组，`cwd` 为已核验且在用户授权范围内的现有绝对目录，可使用外部 worktree、工具目录或其子目录；省略时使用任务原目录），调用 `invoke-codex.ps1 -BackgroundRequest REQUEST_JSON`。包装器只提交请求，返回 `[CODEX_BACKGROUND_WAIT]` 与随机命令 ID，尚不代表业务进程已启动；Codex 原样交接并立即结束该轮。CLI 退出后，worker 才启动本地 Node supervisor，登记真实 PID 与启动身份，避免后台进程继承 CLI 生命周期。

请求文件和 supervisor 登记、日志仍必须位于当前任务的 `background` 目录，外部工作目录不改变任务和会话归属。桥接不另加工作目录沙箱，实际文件访问仍受执行环境权限与用户授权约束。`cwd` 不能是相对路径、不存在的目录或普通文件。

worker 核对任务、物理路径、启动时间、真实 supervisor 命令行及子进程归属后，进入 `waiting_background`。这段时间没有 CLI 或模型轮询，也不发终态通知；默认每 60 秒本地检查，完成文件落盘可立即响应。取消和剩余任务总时限独立响应，只终止身份匹配的所属进程树。完成后自动 resume 原 thread，注入真实退出码和日志尾部，继续下一步；非零退出和未确认退出均不算通过。普通 `[CODEX_BACKGROUND_RUNNING]` 保持原来的人工核查语义，不自动接管任意 PID。

进程查询超时或查询服务暂不可用时，保留原命令与 `waiting_background`，记录 `process_alive=null` 和原始观测错误，再按本地检查间隔重验；不能把观测失败当作进程退出、成功或可重复执行。初始 OS 校验未完成时保留待核验状态，恢复后补齐校验，不跳过归属检查。登记损坏、nonce 不符和进程身份不一致仍按真实错误处理。文件监听失效后由定时检查兜底；取消或明确正时限触发时，若归属无法确认则不杀未知 PID，结果保留未确认终止说明。

后台命令长时间托管时保持静默，不发送 15 分钟等待提醒；旧版遗留的 `background_status` 也静默处理。每次观测异常都保留本地事件，连续两次失败才发布 `monitoring_alert`，恢复后重新计数；取消或到期时无法确认终止则立即告警。收到后先简短反馈，不领取终态、不重派任务。业务脚本仍须按自然工作单元刷新实际进度和 checkpoint；桥接不会从进程存活或日志字节数推断业务进度，也没有新增日志语义监控。

Windows 进程观测使用按托管生命周期复用的 PowerShell JSONL 协进程，每次检查合并读取 supervisor 与已登记子进程的启动时间、命令行、可执行路径和父进程。查询异步执行，单次上限 30 秒，响应最多 64 KiB；查询通道异常后关闭，后续观测可重建。supervisor 在业务命令启动前确认自身身份，瞬态失败最多尝试两次，策略拒绝不重试；随后复用已启动的查询进程读取子进程身份。激活等待登记的窗口为 100 秒，启动结果未知时仍禁止重放业务命令。等待结束关闭查询进程，不新增跨任务缓存；取消仍由同一 Process 对象复核启动身份后终止所属进程树。

模型任务默认不限累计执行时间，不按托管时长发送状态提示或停止任务。编排端优先向用户说明短批次方案，先验证实际逻辑和代表性输出，再扩大计算；每批保留结果、未验范围与 checkpoint，短批次不能替代原定完整验收。仅用户明确要求时才设置任务时限；单次网络或状态查询超时不应被混同为任务到期。用户随后补充的这项分批原则只调整编排正文，不改变上述已验证的运行器代码。

通知器在每个项目内最多同时占用四个宿主投递槽，同一聊天串行投递，慢会话不会独占其它会话的投递路径；这不是后台执行任务数量限制。通知进程与 worker 独立，通知失败不终止业务命令；发送结果未知仍不自动重发。宿主 API 接受之后的模型超时仍可能延迟聊天展示，本修复不保证界面即时可见。2026-11-18 核对当前宿主的 `agentapi --help`，只列出 `get-conversation-metadata`、`new-conversation` 和 `send-message`，没有直接状态卡或用户已展示确认命令；桥接不能据此宣称绕过模型展示或确认用户已读。

本批验收（2026-11-18 18:23，UTC+8）：修复进程观测暂错导致托管失败，以及进程查询期间完成文件发布、随后被误报为未知退出的竞态；初始归属待核验时，取消和时限也必须补齐验证，不能终止未知 PID。主线程独立故障回归 14/14 通过，最终固定源码 `npm test` 168/168 通过、无失败或跳过，耗时 441736.7833 ms；JavaScript/PowerShell 语法、UTF-8 无 BOM 和 `git diff --check` 通过。最终运行器与回归测试的联合 SHA-256 在全套前后保持一致。无 Graphify 索引，不执行索引刷新；未调用真实模型或业务任务。

Git 交付（2026-11-18，UTC+8）：main 已完整包含任务分支 `fix/background-observation-continuity` 的交付提交 `179dfa7a863ba619cc998dc73b1f1b8d4e2a6441`，实现提交为 `b32bff2c37426409de3709430c2aaa089a5ec60c`。首次 main 推送被自动审批因授权范围拒绝；用户随后明确授权推送，普通推送成功，交付记录推送后远端 main 回读为 `370cec06333034e178d9bbe77f0870a82f713bc0`，任务分支独有提交为零。远端分支删除曾被自动审批以缺少明确删除授权拒绝；用户随后明确授权删除，经再次核对远端 SHA、main 可达性及 worktree 占用后，用预期 SHA 租约删除远端分支，并用 `git branch -d` 删除本地分支。独立回读确认两处分支均不存在，main 仍完整包含交付提交，工作区干净；未创建 worktree。本段后续仅更新交付记录，运行器源码不变。

本机配置同步通过既有安装器完成，只更新 MCP 与 Sidecar 的两项构建指纹，重新预览为零项变更，既有安装 journal 无冲突。MCP 注册检查退出 0，版本 1.6.2、工具数 9；通知宿主自动重载为 PID 39772，运行指纹与配置一致，六个项目监听在线。在途股票任务 `640c0ab93a366f4f45791f3e` 回读为 `waiting_background`、`timeout_seconds=0`，未重启或重派。当前聊天加载新 MCP/规则及真实通知展示仍未完成界面验收；本轮仅配置与文档更新，沿用固定运行器的 168/168 测试结果，未调用模型或重跑业务。回滚继续使用连接层既有 `install-state.json`，最终测试日志继续保留待宿主验收，没有新建临时产物。

两次早期全套分别在补齐取消边界和修正新增测试的摘要取值后主动停止，未记为通过；先行固定版本 166/166 通过后，再补入完成竞态回归并执行上述最终全套。旧隔离 fixture 与被最终结果替代的日志已精确清理，只保留最终测试原始日志供待完成的合并和宿主验收，结束后可清理。一次旧 fixture 清理被自动审批因检查进程命中而拒绝，补充排除检查自身、确认无活动依赖的只读证据后，同一路径清理获正式审批并完成，未更换接口绕过。

Node 只管理进程，业务脚本继续由请求指定的 Python 等解释器执行。每条命令只保留当前和上一份各 8 MiB 的捕获日志；返回上下文最多读取末尾 8 KiB。业务数据仍写入业务原定目录。任务目录内登记及结果随现有任务记录保留；完成前不要删除。worker 意外退出时保留所属登记与会话，不能重派原命令。

启动参数保留 `features.unified_exec=false` 以兼容旧 CLI，但新 CLI 可能忽略该设置，不能据此宣称提供同步 `shell_command`。只有实际 schema 提供该工具时才使用 `timeout_ms`；当前兼容路径通过受控托管验收。

验证记录（2026-11-16，UTC+8）：Windows 全量 mock 测试 147 项通过，补丁格式检查通过。真实 CLI 普通模式运行 Python 95.01 秒，等待窗口只有本地检查事件，原生会话中没有工具调用、新轮次或用量事件；完成后自动恢复同一会话并实际校验结果及后续计算。样本曾因把后台 ID 当作 CLI 证据 ID 而被报告校验器拒绝；保留原拒绝，补充 ID 区分提示后，仅续接结果核对即取得有效报告，没有重跑 Python。该验收不表示 Antigravity 已重载连接或完成真实聊天界面验收。

耗时任务的早检与 Sol/Terra 分工见[编排规则的“等待与结果”](../.agents/rules/antigravity-codex.md#等待与结果)。包装器向审核和执行阶段注入对应提示，要求先核查实际代码，再用代表性短跑或分段结果决定是否继续本地长跑。此处只强化编排与执行提示，不增加运行中日志语义监控、强制模型路由或写隔离；现有托管接口和 general/quant 审核映射保持原有行为。

本批记录（2026-11-17 21:48，UTC+8）：补齐长跑早检、证据复用、checkpoint 与源码修复交接，由 Sol 修改、Terra 运行测试，保留原生 spawn/wait 证据。首轮完整测试 124/150 通过、26 失败，启动后才修正旧措辞探针，不能作为固定版本验收，也未认定它是全部失败的唯一根因；修正后固定源码的完整 `npm test` 退出 0，150 通过、0 失败/跳过，耗时 717376.6682 ms。主会话复核日志、审核路由及 7 个提示检查，PowerShell/JavaScript 语法、UTF-8 无 BOM、`git diff --check` 均通过；无 Graphify 索引。交付提交 `1fd9e88` 已快进合并到 main 并普通推送，远端 main 与任务分支 SHA 已回读一致。本机 Antigravity MCP 和 Sidecar 仅同步 `CODEX_EXECUTOR_BUILD`，模型、权限和项目路径保留；安装器应用 2 项变更，重建预览 0 项变更，既有回滚 journal 冲突检查为 0。MCP、Sidecar 配置与通知器运行指纹一致；宿主自动重载通知器，监听在线，未手动重启。已注册项目的规则包装文件均引用桥接同一正文，无需复制或改动业务仓库。`scripts/verify.cjs` 普通注册检查退出 0，`codex_registered=true`、`server=codex-executor`、`version=1.6.2`、`tools=9`，未调用真实模型或业务任务。界面工具返回 `native pipe unavailable (os error 2)`，未能刷新界面，MCP 及规则在当前宿主会话中的加载与真实长任务早检仍未验证；在途任务未重启或重派，未新增运行中日志监控或强制模型路由。测试 fixture 自动清理，临时日志及首轮空目录已删除并回读确认，无新临时文件或 worktree；用户明确授权后，本地及远端 `feat/long-run-preflight` 均已删除并独立回读确认，远端该任务分支已不存在，main 仍包含交付提交。

Windows Hook 经宿主参数转义后交给 `cmd.exe /c`。生成的 `command` 值完全不含单双引号，不能使用 PowerShell 的 `& '路径'`，也不能依赖 `call "路径"` 绕过宿主转义。命令只带 pwsh、脚本及 MCP 配置路径；Node 路径由脚本内部读取 MCP 配置，未配置时才查找 PATH，显式 `-NodeEntry` 仍适用于直接调用和 Sidecar。

Hook 路径含空格或 `&` 时，安装器尝试现有路径的 8.3 短名；短名不可用或含不支持的命令字符时，在写配置前明确失败，请改用不含空格和元字符的安装路径。不会静默换程序或生成仍带引号的命令。回归测试覆盖普通 argv 转义、原样 `cmd /c` 和 shell 调用，以及中文 JSON 与带空格的 Node 配置路径。

## 回滚安装

安装器在指定 data 根维护一份 `install-state.json`。它只记录自己接管的配置字段；再次安装时保留最初基线，幂等安装不覆盖回滚依据。

```pwsh
pwsh -NoProfile -File scripts/Setup.ps1 --restore 'C:/codex-runtime/my-project/install-state.json'
```

回滚前检查接管字段是否被其它工具或用户修改。检测到变化会拒绝覆盖，避免破坏后来配置。回滚不取消 Codex、不删除研究产物，也不撤销任务源码改动。安装状态可能包含本机配置和敏感环境变量，不要提交或公开。

## 外部工作目录与等待提醒修复记录

2026-11-19 02:41（UTC+8）：已创建的独立 worktree 在托管探查时被 `contained(job.cwd, request.cwd)` 拒绝。现允许使用用户授权范围内的现有绝对工作目录，省略时沿用原目录；请求文件、登记、日志和取消对象仍受当前任务归属校验。取消 15 分钟等待提醒的生成与投递，旧 worker 遗留的 `background_status` 也静默处理，观测异常和终态通知保留。

验证：`npm test` 175/175 通过，无失败、取消或跳过，耗时 427741.8558 ms；覆盖外部中文目录的真实子进程执行、默认目录、无效目录不占用命令槽、旧提醒静默以及原有取消和身份边界。JavaScript/PowerShell 语法、UTF-8 无 BOM、`git diff --check` 通过。目录校验只增加固定次数的文件系统检查，没有目录遍历、新缓存或队列；原有单次交接去重、日志轮转和有界读取测试通过。本仓库无 Graphify 索引，未刷新。

本机仅同步两个既有 MCP 入口与通知宿主的构建指纹，沿用连接层安装 journal；三处指纹一致，复查零项配置变更，journal 无冲突。通知宿主已自动加载新构建，五个项目监听在线；无模型注册检查通过，版本 1.6.2、工具数 9。没有取消、重启或重派在途业务命令；原受阻会话的实际业务探查和端到端验收仍待续接。旧 worker 的内存代码不会热替换，新通知器负责屏蔽其遗留等待提醒。

Git（2026-11-19，UTC+8）：用户明确授权后，本地切回 main，快进合入实现提交 `64f7ede038f89bca32271c10a39ec66abac9c17d` 与交付记录提交 `cb32fe202481d74caff5cddac9c841a802a6e8b3`，普通推送成功；远端 main 回读为 `cb32fe202481d74caff5cddac9c841a802a6e8b3`、分歧 0/0。本轮任务分支独有提交为零且无 worktree 占用，随后按预期 SHA 租约删除远端分支，用 `git branch -d` 删除本地分支；其他分支保持原样。首次任务分支推送曾因远端归属未验证被自动审批拒绝，通过现有 GitHub 登录只读确认账号与仓库 owner 相同且具备管理、推送权限后，补证审批通过。本段后续仅更新交付状态，运行器未改动，沿用上述 175/175 测试。

Antigravity 切换回读：两个 MCP 入口均引用当前 main 所在的同一源码目录，源文件联合指纹与两个入口、通知宿主记录一致；通知宿主进程身份已核对，五个项目监听在线。两个现存 MCP 连接进程早于本轮修复，不能据配置一致宣称已热加载；Computer Use 原生管道不可用，界面刷新连接和界面验收尚未完成。未终止 MCP、worker 或业务监督进程，也未重派原业务；可通过 Antigravity 的 MCP 管理界面刷新连接，继续使用原会话。没有创建 worktree；测试入口已清理本次成功 fixture，没有新增工具、环境、研究数据或待清理的临时脚本。本机安装 journal 留在既有连接层运行目录供回滚使用，不进入 Git。

## Windows 进程查询超时修复记录

2026-11-19 21:34（UTC+8）：原身份检查反复同步冷启动 PowerShell，单次 10 秒超时会阻塞观测，启动时还会直接使监督进程失败。现改用按需启动的私有常驻查询进程，异步 JSONL 请求合并监督进程及子进程属性，单请求 30 秒超时；监督启动身份查询最多两次，登记等待窗口为 100 秒，业务命令不重放。启动时间、监督命令行及父子关系校验保留；观测失败保留业务进程，终止回执未知不重试终止。完成、取消与时限事件可打断只读查询；查询进程、请求计时器及文件句柄按生命周期关闭，响应和 stderr 有界。聊天告警改为连续两次观测失败，每次异常仍记录事件；终止归属或结果未知立即告警。

固定源码完整 `npm test` 187/187 通过，失败、取消、跳过均为零，耗时 528815.4764 ms；专项回归 26/26 通过，覆盖真实 PowerShell 查询复用、异常重建、完成/取消竞争、PID 归属和未知终止不重试。首轮全套因测试替身把幂等释放的两次调用当作两次有效释放而失败，修正替身后重跑上述完整测试，未放宽进程安全断言。源码与测试联合 SHA-256 在最终全套前后均为 `e289f16a3eadf85553db868dec1ae2399354543afbfffa6c62bcd20c5c92fdbd`；语法、UTF-8 无 BOM 和补丁格式检查通过。本机六次查询样本复用同一个 helper，首查 3000.8 ms，后五次 724.4–843.5 ms；这是当前负载的小样本，未复现极端负载或证明毫秒级响应。没有调用真实模型或业务任务，无 Graphify 索引。

本机仅同步两个 MCP 入口及 Sidecar 的三个构建指纹字段，独立回读一致，其它配置字段摘要不变。原安装记录与当前配置已有外部差异，未改写原记录；本次使用现有安装器事务，在本功能外部运行目录保存只接管三个叶字段的 `install-state.json`，回读无冲突。两个入口的无模型注册检查均通过，版本 1.6.2、工具数 9；通知宿主自动加载新指纹、五个项目监听在线。现有 MCP 连接进程仍早于修复，Computer Use 管道不可用，界面刷新连接和真实业务续接仍待验收；未停止或重派在途任务。

按用户要求，桥接仓库自身允许 Antigravity 直接修改、测试和上传，不再要求通过 Codex MCP 派发；保持自身未登记与规则排除，其它业务项目的执行约束不变。用户随后明确授权更新 main；2026-11-19 21:40（UTC+8），修复提交 `acbba4834dfef09d9758b0ee72177d89b05a400a` 已快进合入并普通推送到 main，远端 SHA 回读一致、分歧 0/0，工作区干净。切换 main 后源码与测试指纹不变，沿用上述 187/187 测试；没有创建 worktree。两个本机 MCP 入口仍指向同一源码目录，通知宿主运行指纹一致；两个现有 MCP 进程仍早于修复，重新尝试界面控制仍返回 `native pipe unavailable`，连接刷新与业务续接待验收。测试 fixture 已清理，最终测试日志和本次最小回滚记录保留在本功能外部运行目录，供宿主验收与回滚使用；没有新增工具、依赖环境或研究数据。

任务分支 `fix/background-query-timeout` 已完整被远端 main 包含、独有提交为零且无 worktree 占用。首次按技能收尾尝试删除远端分支时，自动审批以“用户未明确授权删除任务分支”为由拒绝，未绕过。用户随后明确授权删除；重新核对远端 SHA、main 包含关系及工作树占用后，按预期 SHA 租约删除远端分支，并以 `git branch -d` 删除本地分支。独立回读确认两处分支均不存在，main 仍包含修复，其它分支未变。本段仅更新交付记录，不改运行器源码。

## 双引擎负载均衡与 AGY 低成本多子代理

桥接默认采用 `auto` 双引擎自动均衡模式（Codex 默认 5 天 100% 等比例消耗预算曲线、AGY 7 天 100% 等比例并叠加 5 小时窗口限制、AGY 受限时由 Codex 兜底），也支持通过本机外部策略文件 `routing-policy.json`（位于默认运行目录的父目录，或由 `CODEX_EXECUTOR_ROUTING_CONFIG` 指定绝对路径，不进入 Git）随时切换为 `agy`（支持 `agy`/`AGY`/`Agy`/`antigravity` 缩写）或 `codex`（严格锁定模式），**无需重启 Antigravity 立即生效**。

### 额度与熔断机制

- **Codex 实时配额与 5 天等比例 Pacing**：通过本机 `codex --no-daemon app-server` 原生 JSON-RPC 方法 `account/rateLimits/read` 获取当前主窗口时长（通常 7 天）、已用百分比、精确重置时间、credits 与免费重置券（默认 60 秒本地缓存，`codex_quota(refresh=true)` 可强制刷新）。默认按周期前 **`plan_days = 5` 天**（可通过 `Mode.ps1 codex-pacing --days N` 调整）等比例走满 100%（起点 $T_{\text{start}} = T_{\text{reset}} - W_{\text{api}}$，目标线 $P_{\text{target}} = \min(1,\ E / W_{\text{plan}}) \times 100\%$，偏差 $\Delta = U - P_{\text{target}}$）分段：
  - `codex_priority`（$\Delta \le -3\%$）：未达到等比例消耗线，优先 Codex；
  - `balanced`（$-3\% < \Delta \le +5\%$）：混合分流（Codex 主力/长后台/审核，AGY 低成本多子代理并行只读与中小改）；
  - `agy_priority`（$\Delta > +5\%$ 或 $U \ge 92\%$）：优先 AGY 低成本多子代理，保留 Codex 撑满 7 天；
  - `codex_protected`（$U \ge 97\%$ 或触发限流）：保护 Codex，新事项默认走 AGY；
  - `codex_drain`（距重置 $\le 12\text{h}$ 且剩余 $\ge 10\%$）：末期冲刺优先 Codex，减少 7 天过期浪费。
- **AGY 7 天 100% 等比例 + 5 小时窗口限制 + Codex 兜底**：由于 Antigravity 官方未提供公开的剩余额度百分比 API，桥接不探测未文档化的宿主私有接口，而是将 AGY 拆为两层：
  - **5 小时滚动限制守卫**：实时汇总本机 `brain/*/.system_generated/logs/transcript.jsonl` 近 5 小时真实 token 消耗与近期 429/配额限流错误（严格排除 401/403 认证与策略拒绝），也支持结合 `Mode.ps1 agy-quota` 手动快照、`Mode.ps1 agy-budget` 本地 5h token 预算或可选外部探针。AGY 5 小时窗口进入警戒区（默认 `75%`）时限速为混合均衡；达到保护线（默认 `88%`）、近期出现 429 限流、标记 `agy_quota_hint=low` 或手动冷却时，只要 Codex 未硬限流，**立刻切由 Codex 兜底**。
  - **7 天 100% 等比例竞比**：当 AGY 7 天进度通过 `Mode.ps1 agy-quota`（未过期快照）、`Mode.ps1 agy-budget`（本地 7d token 预算）或可选外部探针标定后，桥接按 7 天 100% 匀速公式计算 $\Delta_{\text{agy}}$，与 $\Delta_{\text{codex}}$ 直接比对（谁更落后于各自进度且差值 $> 5\%$ 就优先谁，差值 $\le 5\%$ 混合分流；距重置 $\le 12\text{h}$ 且剩余 $\ge 10\%$ 自动冲刺消化尾额）。未标定时不伪造百分比，按 Codex 5 天曲线叠加 AGY 5 小时守卫调度。
- **可选外部探针**：可在本地 `routing-policy.json` 配置可选 `agy_quota_command`（命令行参数数组，输出含 `remaining_percent` 或双窗口 `five_hour_used_percent` / `weekly_used_percent` 的 JSON），默认禁用；失败时显式报错，绝不伪造 100%。

### 模型档位对齐、高缓存复用与量化最强思考

- **AGY 对称执行档位与高缓存保活**（默认，可通过本机策略自定义）：`simple`/只读 `research` → `flash_lite`，`standard`（执行默认兜底）→ `flash`，`complex` → `pro`，`expert` → `inherit`。在 `auto`/`agy` 模式下，`PreToolUse` Hook 通过官方 `overwrite` 自动把未指定模型（或普通子任务误传 `inherit`）的 `invoke_subagent` 路由到低成本档位，防止误烧高配主模型；同模块内通过 `send_message` 长期复用同一低成本子代理以维持高缓存命中率。还可通过 `scripts/Mode.ps1 agy-models --standard ... --complex ... --expert ...` 在本机外部策略登记各档对应的 AGY 主对话模型名称（公开仓库默认为 `null`，不硬编码个人模型 ID）。
- **量化策略研究最强思考**：可在本地策略中通过 `scripts/Mode.ps1 quant-thinking --model MODEL_NAME` 配置本机量化最强思考模型（不写入公开仓库代码）。在 `review_category=quant` 项目中，`SessionStart`/`PreInvocation` 钩子会核对主会话模型并在不匹配时提示切换；同时量化策略思考类子任务显式保留 `inherit`/`pro` 不降级，日常清洗/检索/测试仍下沉低成本执行。

### AGY 黄金混血审核与智能防死循环门禁

- **先审后做门禁（`agy_guard.review_gate`）**：支持全局或按项目配置 `off` / `advisory`（默认）/ `strict`。在 `strict` 模式下，AGY 执行写文件或启动非只读执行子代理前，`PreToolUse` 会核查当前项目最近 `review_valid_hours`（默认 12 小时）内是否存在已通过的 Codex 独立审核回执（`plan_review.status=approved`）；缺失时返回 `[AGY_REVIEW_REQUIRED]`，只读 `read_file` 与 `research` 子代理不受阻。
- **智能防死循环（`PostToolUse` + `PreToolUse`）**：区分“正常多点排错”与“同错死循环”——不同文件或不同错误连续失败时允许代理自主修复；仅当**同一规范化错误连续重复 3 次**（`max_same_error_failures=3`）或**连续 8 次工具全失败且中间零成功进展**（`max_consecutive_failures=8`）才触发 `[AGY_LOOP_GUARD]` 熔断。任何成功执行或新用户输入自动清零；捕获 429/配额错仅触发 AGY 15 分钟冷却交由 Codex 兜底，不计实现失败。

### 常用控制命令（免重启）

```pwsh
pwsh -NoProfile -File scripts/Mode.ps1 status --refresh
pwsh -NoProfile -File scripts/Mode.ps1 set --mode auto
pwsh -NoProfile -File scripts/Mode.ps1 set --mode agy --project 'C:/work/my-project'
pwsh -NoProfile -File scripts/Mode.ps1 set --mode codex --project 'C:/work/my-project'
pwsh -NoProfile -File scripts/Mode.ps1 codex-pacing --days 5 --target 100
pwsh -NoProfile -File scripts/Mode.ps1 quant-thinking --model 'YOUR_STRONGEST_THINKING_MODEL'
pwsh -NoProfile -File scripts/Mode.ps1 agy-models --standard 'YOUR_FAST_EXEC_MODEL' --complex 'YOUR_COMPLEX_MODEL' --expert 'YOUR_EXPERT_MODEL'
pwsh -NoProfile -File scripts/Mode.ps1 agy-hint --level low
pwsh -NoProfile -File scripts/Mode.ps1 agy-quota --weekly-used 35 --weekly-reset '2026-11-28T15:14:55Z' --5h-used 40 --5h-reset '2026-11-25T13:00:00Z'
pwsh -NoProfile -File scripts/Mode.ps1 agy-budget --tokens-5h 8000000 --tokens-7d 80000000
pwsh -NoProfile -File scripts/Mode.ps1 agy-review-gate --level strict --project 'C:/work/my-project'
pwsh -NoProfile -File scripts/Mode.ps1 reset-agy-guard
pwsh -NoProfile -File scripts/Mode.ps1 cooldown --engine agy --minutes 60 --reason '5h quota low'
```
