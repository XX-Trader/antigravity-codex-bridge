# 实战配置与模型选型指南（Codex + Antigravity 双引擎）

本文提供一套可直接落地的**脱敏配置模板与日常选型规范**，涵盖：

1. **Codex 侧**：执行档位分工（常规执行用轻量模型、改代码用主力模型、只读审核用顶配模型）、思考强度与普通模式配置；
2. **Antigravity（AGY）侧**：主窗口模型选型、思考强度、多子代理 4 档映射、`routing-policy.json` 双引擎线性均衡；
3. **Claude 独立模型池**：什么时候用 Claude、怎么选思考强度与角色、如何走本机 `Mode.ps1 pool-run` 避免误调未登录外部 CLI；
4. **日常运维与升级重载清单**。

> [!IMPORTANT]
> 本文所有路径、项目名与模型 ID 均为**脱敏示例**。实际部署时请替换为你的本机真实绝对路径，并以你账号在 `~/.codex/models_cache.json` 与本机 Antigravity 客户端中实际可见的模型为准，不要在公开仓库中提交个人路径、项目名、密钥或运行日志。

---

## 一、双引擎职责与模型分工总览

| 引擎 / 池 | 角色定位 | 推荐模型（示例） | 推荐思考强度 | 典型场景 |
| --- | --- | --- | --- | --- |
| **Codex `simple` / `standard`（默认）** | 常规执行与批处理主力 | `terra`（如 `gpt-6.1-terra`） | `medium` | 数据采集、跑批计算、执行已核验脚本、日志核查、单步查询、结果分析 |
| **Codex `complex`** | 源码修改与复杂实现 | `sol`（如 `gpt-6.2-sol`） | `medium`（疑难可临时提至 `high`） | 修改源码、功能开发、跨模块重构、复杂排障修复 |
| **Codex `review` / `quant_review`（只读）** | 独立方案审核与把关 | `astra`（如 `gpt-6.2-astra`） | `medium` | 新事项首轮只读审核、`review_only=true` 方案复核、量化防过拟合/PIT 审核 |
| **Codex 原生子代理（`spawn_agent`）** | 批内并行子任务 | `terra` / `luna`（如 `gpt-6.1-terra`、`gpt-6-luna`） | `medium` | 同会话内的分片采集、批量起草、独立子包执行 |
| **AGY 主窗口（常规）** | 日常对话与编排 | 本机 `standard` / `complex` 档（如 `hydrogen` / `neon`） | `low` ~ `medium`（复杂时 `high`） | 日常需求拆解、文档整理、多任务调度与回执验收 |
| **AGY 主窗口（量化/极难）** | 核心策略思考与架构定案 | 本机 `expert` 顶配档（如 `carbon`） | `high` ~ `xhigh` | 量化因子假设、样本外/PIT 框架、重大架构决策、疑难根因定位 |
| **AGY 子代理（`invoke_subagent`）** | 低成本检索与受控并行 | `flash_lite` / `flash` / `pro` / `inherit` | 随模型档位 | 调研/检索用 `flash_lite`，常规实施用 `flash`（同模块复用保缓存），**高推理/审核必须用 `inherit`** |
| **AGY Claude 独立模型池** | 异构第二意见与顶配备用链 | 审核 `claude-opus-*` / 默认 `claude-sonnet-*` | `high` | 主思考模型触线时的顺位备用、关键架构/量化对抗复核、用户显式点名调用 |

---

## 二、Codex 侧配置（执行用低成本、改代码用主力、审核用顶配）

### 1. 为什么把 `standard` 设为低成本执行、`complex` 设为改代码

在 [model-policy.cjs](../src/model-policy.cjs) 中，调用 `codex_run` 若未显式传 `execution_tier`，默认落入 **`execution_models.standard`**；续接既有会话则自动继承原会话模型。

- 把 `simple` 与 `standard` 都映射到轻量执行模型（示例 `terra`），可避免日常跑批、拉数据、跑脚本等未指定档位的新事项白白消耗高价编码模型；
- 凡涉及**修改源码、新增功能、跨模块修复或疑难排障**，派发时显式传 `execution_tier="complex"`（映射到主力编码模型，示例 `sol`）；
- 首轮独立审核和 `review_only=true` 始终走独立审核配置（`CODEX_EXECUTOR_REVIEW_MODEL` 与 `CODEX_EXECUTOR_QUANT_REVIEW_MODEL`，示例均为 `astra`），且 `review_only_models` 名单中的模型受只读沙箱约束，**禁止进入执行阶段**。

### 2. 思考强度与关闭 Fast 模式

- **思考强度（`CODEX_EXECUTOR_REASONING_EFFORT`）**：建议保持 **`medium`**。日常修改与跑批在 `medium` 下兼具速度与稳定性；除非面对极复杂推导，不建议把全局默认拉高到 `xhigh` / `max`（会明显拉长耗时并放大周额度消耗）。
- **关闭 Fast 模式**：桥接启动层固定强制 `service_tier="default"` 与 `features.fast_mode=false`，避免误开 Fast 造成 2 倍额度消耗。

### 3. `mcp_config.json` 脱敏模板（`~/.gemini/config/mcp_config.json`）

如需并发双通道，可同时配置 `codex-executor` 与 `codex-executor-parallel`（`env` 保持一致）：

```json
{
  "mcpServers": {
    "codex-executor": {
      "command": "C:\\Program Files\\nodejs\\node.exe",
      "args": [
        "C:\\path\\to\\antigravity-codex-bridge\\src\\server.cjs"
      ],
      "timeoutSeconds": 14460,
      "enabledTools": [
        "codex_run",
        "codex_wait",
        "codex_sessions",
        "codex_result",
        "codex_cancel",
        "codex_list",
        "codex_quota"
      ],
      "env": {
        "CODEX_EXECUTOR_PROJECT": "C:\\work\\my-quant-project",
        "CODEX_EXECUTOR_DATA": "D:\\BridgeData\\sessions\\my-quant-project",
        "CODEX_EXECUTOR_ENTRY": "C:\\Users\\<USER>\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe",
        "CODEX_EXECUTOR_PWSH": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "CODEX_EXECUTOR_MODEL": "terra",
        "CODEX_EXECUTOR_REASONING_EFFORT": "medium",
        "CODEX_EXECUTOR_SERVICE_TIER": "default",
        "CODEX_EXECUTOR_ALLOW_SANDBOX": "0",
        "CODEX_EXECUTOR_REVIEW_CONFIG": "C:\\Users\\<USER>\\.gemini\\config\\mcp_config.json",
        "CODEX_EXECUTOR_REVIEW_MODEL": "astra",
        "CODEX_EXECUTOR_QUANT_REVIEW_MODEL": "astra",
        "CODEX_EXECUTOR_REVIEW_CATEGORY": "general",
        "CODEX_EXECUTOR_MODEL_ALIASES": "{\"luna\":\"gpt-6-luna\",\"terra\":\"gpt-6.1-terra\",\"sol\":\"gpt-6.2-sol\",\"astra\":\"gpt-6.2-astra\"}",
        "CODEX_EXECUTOR_EXECUTION_MODELS": "{\"simple\":\"terra\",\"standard\":\"terra\",\"complex\":\"sol\"}",
        "CODEX_EXECUTOR_MODELS_CACHE": "C:/Users/<USER>/.codex/models_cache.json",
        "CODEX_EXECUTOR_NORMAL_MODE_MODELS": "[\"luna\",\"terra\",\"sol\",\"astra\"]",
        "CODEX_EXECUTOR_REVIEW_ONLY_MODELS": "[\"astra\"]",
        "CODEX_EXECUTOR_PROJECTS": "[{\"project\":\"C:\\\\work\\\\my-quant-project\",\"data\":\"D:\\\\BridgeData\\\\sessions\\\\my-quant-project\",\"review_category\":\"quant\"},{\"project\":\"C:\\\\work\\\\my-app-project\",\"data\":\"D:\\\\BridgeData\\\\sessions\\\\my-app-project\",\"review_category\":\"general\"}]"
      }
    }
  }
}
```

> [!TIP]
> `CODEX_EXECUTOR_ENTRY` 直接指向全局 npm 安装后的原生 `codex.exe` 时，后续执行 `npm i -g @openai/codex` 可自动跟随新版本；但升级 npm 包前须确保当前无在途 Codex 任务，避免 Windows 文件锁冲突。同时注意：修改 `CODEX_EXECUTOR_MODEL` 与 `CODEX_EXECUTOR_EXECUTION_MODELS.standard` 时务必**同一次原子保存**，保持两者一致。

### 4. `sidecar.json` 同步要求（`~/.gemini/config/sidecars/codex-executor/sidecar.json`）

`sidecar.json` 中的 `CODEX_EXECUTOR_*` 环境变量（尤其是 `CODEX_EXECUTOR_ENTRY`、`CODEX_EXECUTOR_MODEL`、`CODEX_EXECUTOR_MODEL_ALIASES`、`CODEX_EXECUTOR_EXECUTION_MODELS`、`CODEX_EXECUTOR_REVIEW_*`）应与 `mcp_config.json` 保持完全一致；修改 `sidecar.json` 后 Antigravity 会自动重启通知 Sidecar，但两个 MCP Server 进程需在宿主内重载或重启 Antigravity 才能生效。

### 5. Codex CLI 全局配置（`~/.codex/config.toml` 核心片段）

```toml
approval_policy = "on-request"
approvals_reviewer = "auto_review"
sandbox_mode = "workspace-write"
model = "gpt-6.2-sol"
model_reasoning_effort = "medium"
service_tier = "default"

[agents]
max_concurrent_threads_per_session = 3
default_subagent_model = "gpt-6.1-terra"
default_subagent_reasoning_effort = "medium"
```

- 终端直接交互用 Codex CLI 写代码时，全局默认 `model` 可保留为主力编码模型（如 `gpt-6.2-sol`）；
- 通过桥接派发任务时，桥接会按 `execution_tier` 显式传 `-m` 覆盖全局 `model`；
- 原生子代理 `default_subagent_model` 设为低成本执行模型（如 `gpt-6.1-terra`），大幅降低并行扇出消耗。

---

## 三、Antigravity（AGY）侧配置：模型、思考强度与 Claude 使用规则

### 1. 主会话模型与思考强度怎么选

在 Antigravity 客户端中，建议按任务认知负荷选择主窗口模型与思考强度（`--effort` 支持 `low` / `medium` / `high` / `xhigh` / `max`）：

| 任务类型 | AGY 主窗口模型档位 | 思考强度 | 说明 |
| --- | --- | --- | --- |
| **日常问答、调度、文档、中小改动** | `standard`（高速轻量档，如 `hydrogen`）或 `complex`（如 `neon`） | `low` ~ `medium` | 避免用顶配思考模型处理机械编排，减少 5h 与 7d 消耗 |
| **跨模块设计、复杂排障、方案审阅** | `complex`（如 `neon`） | `medium` ~ `high` | 平衡推理深度与响应速度 |
| **量化策略研究、因子/PIT 因果实证、极难设计** | `expert`（本机最强思考档，如 `carbon`） | **`high` ~ `xhigh`** | 核心假设与架构由主会话顶配完成，配合 Codex `quant` 独立只读审核 |
| **批量检索、日志分析、明确范围写代码/跑测试** | 下沉给子代理或派发 Codex | — | 不要让高配主窗口亲自跑长循环读写 |

### 2. AGY 多子代理 4 档映射与“防盲目降档”原则

通过 `routing-policy.json` 的 `agy_tiers` 控制 `invoke_subagent` / `run_workflow` 档位：

- **`simple` → `flash_lite`**：纯文件检索、日志归类、简单只读调研（成本最低）。
- **`standard` → `flash`**：边界明确、契约已冻结的常规实现与测试；**同一模块内持续用 `send_message` 复用同一个子代理**，保持高前缀缓存命中率，不要反复冷启动新子代理。
- **`complex` → `pro`**：中等偏复杂实现。注意：Antigravity 枚举里的 `pro` 底层仍属轻量家族高强度档，**不等同于主窗口顶配模型**。
- **`expert` → `inherit`**：**真正继承当前主窗口顶配模型**。凡涉及方案审核、对抗复核、根因诊断、架构设计、量化实证或复杂跨模块修改的子代理，必须显式传 `Model="inherit"`，严禁降档到 `flash_lite` / `flash`。

### 3. 什么时候使用 Claude 模型（`agy_model_pools.claude` 独立模型池）

在 Antigravity 中，第三方 Claude 模型拥有独立于主池的配额桶（`3p-5h` 与 `3p-weekly`），通过 `agy_model_pools.claude` 统一纳管。

#### 推荐使用 Claude 模型的 3 类场景
1. **主思考模型受限时的备用接管**：当主思考模型（如 `thinking_models.quant` 配置的 `carbon`）触及 7 天 90% 保护线、5 小时 88% 保护线或遭遇 429 冷却时，按 `thinking_models.backups` 顺位自动切到 Claude 池（例如：`claude-opus-5-5-high` → `claude-sonnet-5-5-high` → Codex `astra`）。
2. **关键方案的异构对抗复核（第二意见）**：重大架构改动、复杂 Bug 根因有分歧、量化策略防过拟合/防未来函数复核，或长规范审阅时，用 Claude `review_model`（如 `claude-opus-5-5-high`，`high` 思考强度）做独立只读审查。
3. **用户显式点名**：你在聊天中明确要求“用 Claude 审一下 / 用 Claude 看这个问题”时。

#### 不建议消耗 Claude 池的场景
- 日常文件检索、批量脚本运行、机械修改、常规单测（这些优先走 Codex `terra` 或 AGY `flash_lite` / `flash`）；
- 当 Claude 池周进度已明显超前（`pacing_delta > 10%`）或进入 5h 警戒（$\ge 75\%$）/ 7d 保护（$\ge 90\%$）时，应暂停非必要调用并退回备用链。

#### Claude 模型选型与思考强度
- **`review_model`（关键审核 / 复杂推理）**：`claude-opus-5-5-high`（`high` 思考强度）
- **`default_model`（常规独立池任务 / 备用实现）**：`claude-sonnet-5-5-high`（`high` 思考强度）

#### 在 Antigravity 中调用 Claude 池的正确姿势
- **当前主窗口本身就是 Claude 模型**：直接在主窗口对话，或 `invoke_subagent(Model="inherit")` 执行。
- **当前主窗口不是 Claude 模型**（因 `invoke_subagent` 的枚举不支持跨家族指定）：直接通过桥接内置命令本地直调，**自动复用本机 Antigravity 登录凭证并遵守 Claude 池配额守卫**：

```pwsh
# 默认 --exec-mode plan（只读审核模式）
pwsh -NoProfile -File scripts/Mode.ps1 pool-run --pool claude --cwd 'C:/work/my-project' --prompt-file 'D:/BridgeData/my-project/review/.tmp/claude-review-prompt.txt'
```

> [!CAUTION]
> 在 Antigravity 会话中严禁绕开本机模型池去调用未登录的外部独立 Claude CLI 或外部 MCP 包装脚本。

### 4. `routing-policy.json` 完整脱敏模板

位于数据根上级目录（例如 `D:/BridgeData/sessions/routing-policy.json`），修改后**免重启立即生效**：

```json
{
  "schema": 1,
  "default_mode": "auto",
  "projects": {},
  "pacing": {
    "plan_days": 5,
    "target_utilization": 100,
    "codex_priority_margin": -3,
    "balanced_upper_margin": 5,
    "agy_priority_used_percent": 92,
    "codex_protect_used_percent": 97,
    "drain_window_hours": 12,
    "drain_min_remaining_percent": 10,
    "ahead_max_concurrent": 3,
    "high_max_concurrent": 2,
    "protect_max_concurrent": 1
  },
  "agy_pacing": {
    "target_utilization": 90,
    "window_minutes": 10080,
    "window_5h_minutes": 300,
    "dual_compare_margin": 5,
    "window_5h_caution_percent": 75,
    "window_5h_protect_percent": 88,
    "weekly_protect_used_percent": 90,
    "buffer_unlock_window_hours": 6,
    "drain_window_hours": 12,
    "drain_min_remaining_percent": 10,
    "window_5h_tokens": 35000000,
    "window_7d_tokens": 280000000,
    "weekly_resets_at": null
  },
  "agy_guard": {
    "max_same_error_failures": 3,
    "max_consecutive_failures": 8,
    "review_gate": "advisory",
    "review_valid_hours": 12,
    "quota_error_cooldown_minutes": 15
  },
  "agy_tiers": {
    "simple": "flash_lite",
    "standard": "flash",
    "complex": "pro",
    "expert": "inherit"
  },
  "agy_host_models": {
    "standard": "hydrogen",
    "complex": "neon",
    "expert": "carbon"
  },
  "agy_model_pools": {
    "claude": {
      "match": "claude",
      "weekly_protect_used_percent": 90,
      "buffer_unlock_window_hours": 6,
      "window_5h_caution_percent": 75,
      "window_5h_protect_percent": 88,
      "window_5h_tokens": 8000000,
      "window_7d_tokens": 40000000,
      "bucket_5h": "3p-5h",
      "bucket_7d": "3p-weekly",
      "default_model": "claude-sonnet-5-5-high",
      "review_model": "claude-opus-5-5-high",
      "manual_snapshot": null,
      "cooldown": null
    }
  },
  "subagent_default_model": "flash",
  "subagent_research_model": "flash_lite",
  "enforce_subagent_low_cost": false,
  "thinking_models": {
    "general": null,
    "quant": "carbon",
    "backups": [
      "claude-opus-5-5-high",
      "claude-sonnet-5-5-high",
      "astra"
    ]
  },
  "agy_quota_hint": "normal",
  "agy_manual_snapshot": null,
  "agy_quota_command": null,
  "agy_probe_home": "D:\\BridgeData\\cache\\agy-probe-home",
  "cache_ttl_seconds": 300,
  "cooldowns": {
    "codex": null,
    "agy": null
  }
}
```

#### 双引擎均衡关键规则速览
- **Codex 线性曲线**：按 `plan_days = 5` 天匀速跑满 100%（每天约 20% 进度；刚重置不久进度较低是正常现象），并作为 AGY 触线时的兜底引擎。
- **AGY 线性曲线与提醒/拦截边界**：
  - 7 天目标上限 **90%**，平时预留 **10%** 应急缓冲；距周重置 $\le 6$ 小时自动解锁剩余 10%；
  - 当 AGY 周用量超前线性目标 **$>10\%$** 时，仅发送**非阻塞提醒**（不拦截），同时 `auto` 路由会自动倾向把新事项派往更落后的 Codex；
  - 只有触及硬保护线（5h $\ge 88\%$ 或 7d $\ge 90\%$ 有效上限）时，才会由 `PreToolUse` 硬拦截重型写入/子代理并切回 Codex 兜底。
- **单边 100% 耗尽交接**：Codex 100% 硬归零时自动解除原事项粘性锁定并免除 `strict` 审核门禁死锁，改由 AGY 接力；双边均 100% 归零时熔断暂停交用户处理。

### 5. Antigravity 宿主设置建议（`~/.gemini/config/config.json` 关键字段）

```json
{
  "userSettings": {
    "enableTerminalSandbox": false,
    "nonWorkspaceFileAccessPolicy": "AGENT_SETTING_POLICY_ALLOW",
    "useAiCredits": false
  }
}
```

- `useAiCredits: false`：避免额度见底时未经确认静默消耗额外 Credits；
- `enableTerminalSandbox: false` 与 `nonWorkspaceFileAccessPolicy: "AGENT_SETTING_POLICY_ALLOW"`：仅在你信任本机项目且需要读写外部数据目录/工具链时启用。

---

## 四、`Mode.ps1` 日常运维命令速查

所有策略变更均**免重启宿主立即生效**：

```pwsh
# 1. 查看双引擎配额水位、线性偏差、Claude 独立池状态与在途任务
pwsh -NoProfile -File scripts/Mode.ps1 status
pwsh -NoProfile -File scripts/Mode.ps1 status --refresh

# 2. 全局或单项目切换执行模式（auto / agy / codex）
pwsh -NoProfile -File scripts/Mode.ps1 set --mode auto
pwsh -NoProfile -File scripts/Mode.ps1 set --mode codex --project 'C:/work/my-project'
pwsh -NoProfile -File scripts/Mode.ps1 reset-project --project 'C:/work/my-project'

# 3. 配置量化思考模型与备用链（含 Claude 池）
pwsh -NoProfile -File scripts/Mode.ps1 quant-thinking --model carbon --backups 'claude-opus-5-5-high,claude-sonnet-5-5-high,astra'

# 4. 配置或更新 Claude 独立模型池
pwsh -NoProfile -File scripts/Mode.ps1 pool --name claude --match claude --default-model claude-sonnet-5-5-high --review-model claude-opus-5-5-high --weekly-protect 90 --unlock-hours 6 --5h-caution 75 --5h-protect 88

# 5. 将 AGY 额度探测目录放到非系统盘纯 ASCII 路径（自动轮转保留最近 10 份日志）
pwsh -NoProfile -File scripts/Mode.ps1 probe-home --path 'D:/BridgeData/cache/agy-probe-home'

# 6. 历史任务运行缓存瘦身（默认干跑预览，确认后加 --apply；保护活跃/近期任务与核心回执）
pwsh -NoProfile -File scripts/Mode.ps1 prune-cache --older-than-days 7
pwsh -NoProfile -File scripts/Mode.ps1 prune-cache --older-than-days 7 --apply

# 7. AGY 账号掉线或切号后显式重新登录
pwsh -NoProfile -File scripts/Mode.ps1 agy-login
```

---

## 五、升级 Codex CLI 与调整模型配置核验清单

1. **检查在途任务**：升级 npm 包或重载 MCP 前，先运行 `Mode.ps1 status` 确认无活跃 Codex 任务（避免锁文件或中断长跑）。
2. **备份配置**：修改 `mcp_config.json`、`sidecar.json`、`config.toml` 前先备份到外部临时目录。
3. **刷新账号模型缓存**：用新版 `codex.exe` 启动一次 `app-server` / `model/list` 或交互会话，确保 `~/.codex/models_cache.json` 中的 `client_version` 与 `models[].slug` 已包含新模型，再更新 `CODEX_EXECUTOR_MODEL_ALIASES`。
4. **本地注册与原生协议校验**：
   ```pwsh
   node scripts/verify.cjs --config 'C:/Users/<USER>/.gemini/config/mcp_config.json' --server codex-executor
   node scripts/verify.cjs --config 'C:/Users/<USER>/.gemini/config/mcp_config.json' --sessions --project 'C:/work/my-project'
   ```
5. **宿主生效**：
   - `routing-policy.json`：免重启立即生效；
   - `sidecar.json`：Antigravity 通常自动热重载 Sidecar；
   - `mcp_config.json`：需在 Antigravity 左侧 **Skills & Customizations → MCP Servers** 中重载 `codex-executor` / `codex-executor-parallel`，或重启一次 Antigravity 让已有 `server.cjs` 进程加载新环境变量。
