# lark-bridge

把飞书即时通讯作为 Claude Code 或 Codex 的交互前端。

飞书用户在群聊或私聊中发消息，daemon 在 7x24 在线的 host 上自动为该会话创建一个后端，把回复以飞书交互卡片实时流式返回。飞书侧无感，和普通聊天体验一致。

支持三种后端/接管方式，每个 chat 独立选择，可随时切换：

| 后端 | 实现 | 说明 |
|------|-----|------|
| **Claude Code** | `@anthropic-ai/claude-agent-sdk` | 默认；细粒度 streaming（thinking / 工具进度 / 打字机文本） |
| **Codex** | `@openai/codex-sdk` | 按需切换；事件粒度比 claude 粗（item / turn 级），飞书"打字机"流式退化为整段一次到位 |
| **tmux** | `tmux send-keys` / `capture-pane` | 可选启用；接管已有或新建的 tmux 中 codex/claude code 会话；电脑端和飞书端可交替操作同一 session |

支持飞书侧 bot 命令显式控制会话：`/help`、`/new`、`/provider`、`/hold`、`/release`、`/state`、`/model`、`/tmux`（详见 [Bot 命令](#bot-命令)）。

## 工作原理

```
飞书用户 ──消息──→ 飞书开放平台
                      │
                      │ WebSocket 长连接
                      ↓
              ┌───────────────────────────┐
              │  7x24 Host                │
              │                           │
              │  lark-bridge daemon       │
              │       │                   │
              │       ├─ Bot 命令分流      │  ← /help /new /provider /hold /release /state /model /tmux
              │       │                   │
              │       ↓                   │
              │  Backend 路由              │
              │   ├─ ClaudeBackend         │  ← @anthropic-ai/claude-agent-sdk
              │   ├─ CodexBackend          │  ← @openai/codex-sdk
              │   └─ TmuxBackend           │  ← tmux pane 接管
              │       │                   │
              │       ↓                   │
              │  Bridge hook 系统          │  ← session/message 生命周期
              │  (aria-memory 集成等)      │
              └─────────────┬─────────────┘
                            │
                            ↓
                   飞书交互卡片 (流式输出)
```

### 关键设计

- **Daemon 是核心**：飞书 WS 长连接 + per-chat 会话管理 + 后端路由都跑在这个 Node.js 进程里。Claude Code 插件壳（hooks/、skills/）是可选的便利层。
- **每 chat 一个 session**：同一时刻只有一个 session 在飞，绑定一种后端和一个启动时模型。`/new`、`/provider` 或 `/model` 显式重置；空闲超时 / 最长时限会被动关闭（除非 `/hold`，可用 `/release` 恢复）。
- **后端可插拔，不继承上下文**：`/provider claude↔codex` 切换 = 关旧 + 开新，per-chat 默认后端与每后端模型覆盖持久化到 `~/.lark-bridge/chat-state.json`。
- **tmux 可交接**：`/tmux attach` 接管电脑上已有的 codex/claude code pane，`/tmux new` 在 host 上新建 pane；lark-bridge detach 时不 kill tmux，电脑端可 `tmux attach -t <session>` 接手。
- **飞书侧无感**：用户只需在飞书中发消息，无需安装任何客户端。

## 插件结构

```
lark-bridge/                       # 仓库根目录
├── .claude-plugin/
│   ├── plugin.json                # Claude Code 插件元数据
│   └── marketplace.json           # Marketplace 索引
├── hooks/                         # Claude Code 插件 hook（仅在装了 Claude Code 时生效）
│   ├── hooks.json
│   └── session-start.sh           # SessionStart hook：在 Claude Code 会话里注入 daemon 状态
├── skills/                        # Claude Code slash commands
│   ├── lark-bridge                # /lark-bridge — daemon 管理
│   ├── feishu-sessions            # /feishu-sessions — 查看活跃会话
│   └── lark-setup                 # /lark-setup — 初始配置向导
├── service/                       # Daemon 组件（核心，不依赖 Claude Code）
│   ├── src/
│   │   ├── index.ts               # Daemon 入口
│   │   ├── config.ts              # 配置加载 (Zod 校验)
│   │   ├── session-manager.ts     # 会话生命周期 + 命令分流
│   │   ├── commands.ts            # /new /provider /hold /release /state /model /tmux 解析
│   │   ├── chat-state.ts          # per-chat 默认后端、模型覆盖、tmux target 持久化
│   │   ├── backend/
│   │   │   ├── index.ts           # Backend 接口 + 工厂 + StreamMessage 协议
│   │   │   ├── claude.ts          # Claude Agent SDK 封装
│   │   │   ├── codex.ts           # Codex SDK 封装（事件适配）
│   │   │   └── tmux.ts            # tmux pane 接管后端
│   │   ├── feishu.ts              # 飞书 WebSocket 客户端 + WS 看门狗
│   │   ├── streaming-card.ts      # 流式响应卡片
│   │   ├── progress-card.ts       # 思考/工具进度卡片
│   │   ├── hooks.ts               # Bridge hook 引擎
│   │   └── memory-wrapup.ts       # aria-memory pendingWrapup 登记（hook 实现）
│   ├── package.json
│   └── tsconfig.json
├── config/
│   └── config.example.json        # 配置模板
└── scripts/
    ├── install.sh                 # 依赖安装 + 编译
    ├── start.sh / stop.sh / status.sh
    └── service.sh                 # 统一入口（nohup / systemd / launchd）
```

## 安装

按你的环境选一种安装方式。

### 方式 A：作为 Claude Code 插件安装（推荐，适合 Claude Code 用户）

需要 host 上已装 Claude Code。

```bash
# 1. 添加 marketplace 源
claude plugin marketplace add https://github.com/whiteParachute/lark-bridge

# 2. 从 marketplace 安装插件（自动编译 daemon 组件）
claude plugin install lark-bridge@lark-bridge-marketplace
```

安装完成后，hooks 和 skills 立即可用，可在 Claude Code 里直接跑 `/lark-setup`、`/lark-bridge start`。

或者从源码挂载：

```bash
git clone https://github.com/whiteParachute/lark-bridge.git
cd lark-bridge && bash scripts/install.sh
claude --plugin-dir /path/to/lark-bridge
# 或写到 ~/.claude/settings.json: { "pluginDirs": ["/path/to/lark-bridge"] }
```

### 方式 B：仅作为 daemon 安装（不依赖 Claude Code）

如果你**没有 Claude Code、只想用 codex**（或者不想引入 Claude Code 这个依赖），daemon 可以独立运行。`hooks/` 和 `skills/` 在这种模式下是惰性文件，不会被加载。

前置条件：host 上 `codex` CLI 已登录（`codex login`）或环境变量 `CODEX_API_KEY` 已设置。

```bash
# 1. 克隆 + 装依赖 + 编译
git clone https://github.com/whiteParachute/lark-bridge.git
cd lark-bridge
bash scripts/install.sh

# 2. 写配置（注意 defaultBackend）
mkdir -p ~/.lark-bridge
cat > ~/.lark-bridge/config.json <<'EOF'
{
  "feishu": {
    "appId": "cli_your_app_id",
    "appSecret": "your_app_secret",
    "allowedSenders": ["ou_your_open_id"]
  },
  "defaultBackend": "codex",
  "codex": { "model": "gpt-5.5", "modelReasoningEffort": "xhigh" },
  "claude": { "workspaceRoot": "~/workspace/lark-bridge" }
}
EOF

# 3. 启动
bash scripts/service.sh start
```

> `claude.workspaceRoot` 即使你不用 claude 后端也要保留 —— 这是两个后端共用的 per-chat 工作目录根。命名仅出于历史原因。
>
> 你不需要装 `@anthropic-ai/claude-agent-sdk` 之外的任何 Claude 相关组件。只要你不发消息进 claude session，这个依赖只是死代码。

### 配置（任一方式）

如果装在 Claude Code 里，可在 Claude Code 中跑交互式向导：

```
/lark-setup
```

向导会依次引导：

1. **飞书应用凭证** — App ID、App Secret、访问控制
2. **后端设置** — 默认后端（claude / codex）+ 各自的 model / workspace
3. **会话参数** — 空闲超时、最大时长
4. **Daemon 模式** — nohup / systemd / launchd、是否开机自启
5. **Hook 配置** — 是否集成 aria-memory（opt-in）、自定义 shell hook

配置保存到 `~/.lark-bridge/config.json`。后续可随时 `/lark-setup reconfigure` 修改。

也可以手动从模板起：

```bash
mkdir -p ~/.lark-bridge
cp config/config.example.json ~/.lark-bridge/config.json
# 填入 appId、appSecret、allowedSenders
```

## 配置

配置文件：`~/.lark-bridge/config.json`（可通过 `LARK_BRIDGE_CONFIG` 环境变量覆盖路径）。

```jsonc
{
  "feishu": {
    "appId": "cli_your_app_id",      // 飞书应用 App ID
    "appSecret": "your_app_secret",   // 飞书应用 App Secret
    "allowedSenders": ["ou_xxx"],     // 允许的用户 open_id（空=允许所有人，启动会警告）
    "allowedChats": []                // 允许的 chat_id（空=允许所有群）
  },
  "defaultBackend": "claude",        // "claude" | "codex"。新 chat 的默认后端
  "claude": {
    "model": "opus",                  // Claude 模型
    "effort": "max",                  // Claude 推理强度：low | medium | high | max
    "workspaceRoot": "~/workspace/lark-bridge",  // 两个后端共用的 per-chat 工作目录根
    "additionalDirectories": [],
    "permissionMode": "auto"          // auto (默认) | acceptEdits | plan | default | bypassPermissions
  },
  "codex": {
    "model": "gpt-5.5",
    "modelReasoningEffort": "xhigh"   // minimal | low | medium | high | xhigh
  },
  "tmux": {
    "enabled": false,                 // 默认关闭；开启后允许飞书白名单用户接管 tmux pane
    "defaultProvider": "codex",       // /tmux new 未指定 provider 时使用
    "providerCommands": {
      "claude": "claude",            // 基础命令；bridge 会追加 model/permission/add-dir
      "codex": "codex"               // 基础命令；bridge 会追加 model/cwd/add-dir/YOLO
    },
    "captureLines": 200,              // 每次 capture-pane 读取的行数
    "pollIntervalMs": 1000,           // 发送消息后轮询 pane 的间隔
    "settleDelayMs": 15000,           // 多少毫秒无新输出后认为本轮完成
    "turnTimeoutMs": 1200000          // 单轮最长观察时间
  },
  "session": {
    "idleTimeoutMs": 1800000,         // 空闲超时 (默认 30 分钟)
    "maxDurationMs": 14400000         // 最大时长 (默认 4 小时)
  },
  "daemon": {
    "mode": "nohup",                 // "nohup" (默认) 或 "service" (systemd/launchd)
    "autoStart": false                // 仅 mode=service 时生效：开机自启
  },
  "hooks": {
    "session": { "pre": [], "post": [] },
    "message": { "pre": [], "post": [] }
  },
  "ariaMemory": {                    // 可选；仅当你启用 aria-memory 集成时需要
    "memoryDir": "~/.aria-memory"     // vault 路径，省略默认 ~/.aria-memory
  },
  "log": {
    "level": "info"
  }
}
```

> Codex 鉴权（`CODEX_API_KEY` 或 `codex login`）**不**在配置文件里。daemon 通过 codex CLI 自身的会话状态访问 OpenAI。

## 使用

### 启动 daemon

`service.sh` 根据配置文件中的 `daemon.mode` 决定运行方式：

```bash
bash scripts/service.sh start       # 启动
bash scripts/service.sh status
bash scripts/service.sh stop
bash scripts/service.sh restart
```

#### daemon.mode = "nohup"（默认）

最简单的方式，`nohup` 后台运行。无崩溃重启，无开机自启。适合开发调试或短期使用。

#### daemon.mode = "service"

注册系统级服务，支持崩溃自动重启（5 秒冷却）：

```bash
# 先在 config.json 中设置 daemon.mode 为 "service"
bash scripts/service.sh install     # 注册服务（仅首次）
bash scripts/service.sh start
bash scripts/service.sh uninstall   # 卸载服务
```

| 平台 | 机制 | 服务文件 |
|------|------|---------|
| Linux | systemd user service | `~/.config/systemd/user/lark-bridge.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.lark-bridge.daemon.plist` |

开机自启由 `daemon.autoStart` 控制，默认关闭。设为 `true` 后重新 `install` 即可生效。

> Linux 上如需用户未登录时也保持服务运行，执行 `loginctl enable-linger $USER`。

日志统一写入 `~/.lark-bridge/bridge.log`，活跃会话快照在 `~/.lark-bridge/status.json`（10 秒刷新一次）。

### 飞书侧

用户直接在飞书中向机器人发消息即可。支持：

- 私聊对话
- 群聊 @机器人
- 发送文本、富文本、图片（仅 claude 后端；codex SDK 的 `Input` 仅支持文本与本地路径图片，不接受 base64，bridge 暂未桥接）、文件
- 以 `/` 开头的 [bot 命令](#bot-命令)

### Bot 命令

发给机器人的消息以 `/` 开头并命中下表首词时，由 bridge 直接处理，**不进入后端 LLM**。其他 `/xxx`（如 Claude Code 自身的 `/init`、`/review`，或文本里随手敲的 `/something`）原样透传给后端。

| 命令 | 行为 |
|------|------|
| `/help` | 显示 bridge 内置命令说明；不进入后端 LLM |
| `/new [prompt]` | 关闭当前会话，用本 chat 当前默认后端开新会话；inline `prompt` 作为新会话首条消息 |
| `/provider <claude\|codex> [prompt]` | 切换本 chat 默认后端（持久化，daemon 重启不丢）+ 关旧会话 + 开新会话；inline `prompt` 作为首条消息 |
| `/hold` | 暂停当前会话的空闲与最长时限计时器，保持会话不被自动关闭 |
| `/release` | 解除 `/hold`，恢复空闲与最长时限自动关闭计时；最长时限按原创建时间继续计算 |
| `/state` | 查询当前会话的状态（后端、模型、是否在执行任务、消息数、运行时长、最近活动、关闭倒计时）；不打断正在执行的任务 |
| `/model [model\|reset] [prompt]` | 查看或设置本 chat 当前后端的模型覆盖；`reset` 清除覆盖并回到配置默认/SDK 默认；设置后会关闭旧会话；无 inline prompt 时下条消息开新会话，有 inline `prompt` 时立即作为首条消息 |
| `/tmux new <session> [claude\|codex] [cwd]` | tmux 启用后可用；创建或接管一个 tmux session；不存在则在 `cwd` 启动对应 CLI，存在则直接接管并先同步当前 pane 输出 |
| `/tmux attach <session[:window[.pane]]>` | tmux 启用后可用；接管已有 tmux target；先把当前 pane 输出作为一轮只读观察流式同步到飞书，后续普通消息会按队列等待上一轮稳定后 paste 到同一个 pane |
| `/tmux detach` | 飞书端退出 tmux 接管，不关闭 tmux session，电脑端可继续操作 |
| `/tmux ls` / `/tmux list` / `/tmux capture [lines]` / `/tmux state` | 列出 tmux sessions、抓取当前 pane 输出、查看 tmux 接管状态；capture 会限制最大行数和消息长度 |
| `/tmux kill <session>` | 仅关闭当前 chat 正在接管的 tmux session；成功后清除该 chat 的 tmux 接管目标 |

切换后端**不继承上下文** —— 新会话从零开始。每个 chat 的默认后端和每后端模型覆盖持久化在 `~/.lark-bridge/chat-state.json`。

tmux 默认关闭，需在配置里显式设置 `"tmux": { "enabled": true, ... }`。开启后，飞书白名单用户可以向接管的 pane paste 输入并读取输出；`/tmux kill` 被限制为当前 chat 正在接管的 session。

tmux 接管不会 kill pane：`/provider claude|codex` 或 `/tmux detach` 只关闭飞书侧桥接会话，tmux 中的 codex/claude code 仍保持运行。电脑端接手时直接执行 `tmux attach -t <session>`。

`/tmux attach` 和 tmux session 启动会先进入只读观察轮：bridge 不发送输入，只轮询 `capture-pane` 并把当前 pane 输出流式刷新到飞书卡片；直到输出静默 `settleDelayMs` 后才认为观察轮完成。观察轮标记为 observation：会显示给飞书侧，但不写 assistant transcript，也不触发 `message.post` hooks。观察轮未完成时收到新的普通消息，bridge 会按队列等待观察轮结束，再把这条消息 paste 到同一个 pane。这样可以降低把新请求打进仍在输出的 TUI 的概率，同时保证不切换 provider 时，飞书侧后续输入都接在 tmux pane 内原有 CLI 上下文之后。

`/tmux new` 会在 `tmux.providerCommands` 的基础命令后自动追加与直接后端对齐的启动参数：
codex 会追加 `--model`、`--config model_reasoning_effort=...`、`--dangerously-bypass-approvals-and-sandbox`、`--cd`、`--add-dir`；
claude 会追加 `--model`、`--effort`、`--permission-mode`、`--add-dir`。`tmux.providerCommands` 只用于配置基础命令或包装脚本名。

tmux 后端没有 SDK turn-complete 事件，只能在 pane 输出静默 `settleDelayMs` 后认为本轮完成；这同样适用于 attach 后的只读观察轮和飞书侧下发的新请求。普通消息会串行投递：上一轮未稳定时，新消息不会提前写 transcript / 跑 `message.pre` hooks / paste 到 pane。飞书消息末尾的 CR/LF 会在发送到 tmux 前剥掉，避免把“发送消息的回车”当成 TUI 输入框里的正文换行；正文内部换行仍保留。单行消息使用 `tmux send-keys -l` 输入后再提交，多行消息才使用 `paste-buffer`。

权限：bot 命令复用 `feishu.allowedSenders` / `allowedChats` 白名单，没有独立权限层。

### Claude Code 侧（仅在装了 Claude Code 时）

通过 skills 管理 daemon：

- `/lark-bridge start|stop|status` — daemon 管理
- `/feishu-sessions` — 查看活跃会话列表
- `/lark-setup` — 初始配置向导

SessionStart hook 在每次 Claude Code 会话启动时注入 daemon 运行状态。

只有 daemon 模式（方式 B）下没有这些命令，请用 `bash scripts/service.sh status` + `cat ~/.lark-bridge/status.json` 替代。

## 会话生命周期

1. 飞书消息到达 → daemon 的 WebSocket 收到
2. 安全校验（allowlist）+ 限流（per-chat 5 token，1/12s 补充）
3. **bot 命令分流**：消息首词命中 `/help`、`/new`、`/provider`、`/hold`、`/release`、`/state`、`/model`、`/tmux` 则在 bridge 内处理；其他 `/xxx` 原样进后端
4. 查找该 chatId 的活跃 session，没有则按本 chat 默认后端（`chat-state.json` 持久值 → `defaultBackend` 兜底）创建
5. `session.pre` hooks 触发
6. `message.pre` hooks 触发 → 消息推送给后端 LLM
7. 后端流式处理 → 实时更新飞书交互卡片（思考进度 + 文本输出）
8. 回复完成 → `message.post` hooks 触发（tmux 只读观察轮除外）
9. 空闲超时 / 最大时长 / 错误 / 服务关停 → `session.post` hooks 触发 → session 关闭（**`/hold` 状态下跳过 9**）

每个 chatId 同一时刻只有一个 session，绑定一种后端。`/provider` 切换后端 = 关旧会话 + 开新会话，**不继承上下文**。

## Hook 系统

Daemon 在 session 和 message 生命周期提供 4 个 hook 插槽：

| 插槽 | 触发时机 |
|------|---------|
| `hooks.session.pre` | 新 session 创建时 |
| `hooks.session.post` | session 关闭时 |
| `hooks.message.pre` | 用户消息推送给后端前 |
| `hooks.message.post` | 后端回复完成后 |

### 内置 hook 类型

**`aria-memory-wrapup`** —— **可选**，opt-in 信号。仅当 `hooks.session.post` 显式包含此项时生效。

行为：feishu 会话关闭时，按 backend 解析真实 SDK transcript 路径（claude: `~/.claude/projects/<encodedCwd>/<sessionId>.jsonl`；codex: 由 `~/.codex/hooks.json` 全局 SessionEnd 自动登记，bridge 这边 no-op），追加到 `<memoryDir>/meta.json.pendingWrapups`。primary host 上的 claude/codex CLI 启动时 aria-memory 自己的 SessionStart hook 会 drain 这个队列并触发 wrapup / sleep。

如果没装 aria-memory（`<memoryDir>` 不存在），hook 静默 skip（debug log），不影响正常使用。

```json
{ "type": "aria-memory-wrapup" }
```

**`command`** —— 执行 shell 命令，上下文通过环境变量传入：`HOOK_PHASE`、`HOOK_CHAT_ID`、`HOOK_CHAT_TYPE`、`HOOK_ROLE`、`HOOK_CONTENT`、`HOOK_SESSION_ID`、`HOOK_BACKEND`、`HOOK_REASON`、`HOOK_TRANSCRIPT_LENGTH`。

```json
{ "type": "command", "command": "your-script.sh", "timeoutMs": 5000 }
```

默认（不配置 `hooks` 字段）：所有 4 个 slot 都为空，无副作用。

> ⚠️ 旧版本字段 `ariaMemory.enabled` / `ariaMemory.variant` / `globalSleep.*` / `wrapupConsumer.*` 已**废弃**。daemon-side 的 `PendingWrapupConsumer` 和 `GlobalSleepScheduler` 已移除 —— 这两件事现在完全由 primary host 的 CLI 处理。旧字段写在 config 里会被忽略并打 warn。

## 后端能力对比

|  | claude | codex |
|---|---|---|
| SDK | `@anthropic-ai/claude-agent-sdk` | `@openai/codex-sdk` |
| 鉴权 | Anthropic API key（SDK 自动处理） | `codex login` / `CODEX_API_KEY` |
| 流式粒度 | 字符级 `text_delta` + 工具进度 + thinking | item 级（agent_message / reasoning / 工具） |
| 飞书"打字机"效果 | ✅ 平滑 | ⚠️ 整段一次到位（SDK 限制） |
| 图片输入 | ✅ | ❌（SDK input 是 string） |
| 工具自动批准 | `permissionMode: auto` + `canUseTool` 回调（永远 allow） | `approvalPolicy: never` + `sandboxMode: danger-full-access`（YOLO）|
| 中断当前 turn | ✅ `query.interrupt()` | ✅ `AbortController.abort()`（via `TurnOptions.signal`） |
| 加载 Claude Code 插件 | ✅ `settingSources: ['project','user']` | ❌ |

tmux 后端不走 SDK，也不解析真实 turn 完成事件。它启动或 attach 后会先只读观察当前 pane 输出；飞书侧发送普通消息时才把输入 paste 到 pane，然后继续轮询 `capture-pane`。观察轮只显示当前 pane 状态，不写 assistant transcript、不触发 `message.post` hooks；普通输入轮会正常进入 transcript/hooks。任一轮在 `settleDelayMs` 时间内无新输出时被视为完成；关闭 bridge session 时不会向 pane 发送 `C-c`，避免误杀电脑端正在运行的任务。

## 前置条件

- 7x24 在线的 host
- 飞书开放平台应用（启用 WebSocket 长连接模式 + `im.message.receive_v1` 事件订阅）
- 至少一种后端的可用凭证：
  - **claude**：Anthropic API key（被 `claude-agent-sdk` 自动读取）
  - **codex**：`codex login` 完成 OAuth，或导出 `CODEX_API_KEY` / `OPENAI_API_KEY`
- *（可选）* Claude Code —— 仅当用安装方式 A 或想用插件 hooks/skills 时需要

## 依赖

- `@anthropic-ai/claude-agent-sdk` — Claude 后端
- `@openai/codex-sdk` — Codex 后端
- `@larksuiteoapi/node-sdk` — 飞书 WebSocket + API
- `pino` — 结构化日志
- `zod` — 配置校验
