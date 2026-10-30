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

每条终态通知只向原会话投递一次。发送结果不明记录为 uncertain，不盲目补发。恢复时复用原会话和运行产物，不重放未知的外部副作用。没有 Sidecar 仍可手动领取结果，但不能承诺自动唤醒。

## 回滚安装

安装器在指定 data 根维护一份 `install-state.json`。它只记录自己接管的配置字段；再次安装时保留最初基线，幂等安装不覆盖回滚依据。

```pwsh
pwsh -NoProfile -File scripts/Setup.ps1 --restore 'C:/codex-runtime/my-project/install-state.json'
```

回滚前检查接管字段是否被其它工具或用户修改。检测到变化会拒绝覆盖，避免破坏后来配置。回滚不取消 Codex、不删除研究产物，也不撤销任务源码改动。安装状态可能包含本机配置和敏感环境变量，不要提交或公开。
