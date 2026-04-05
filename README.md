# lark-bridge

Claude Code 插件 — 将飞书即时通讯作为 Claude Code 的交互前端。

飞书用户在群聊或私聊中发消息，插件在 7x24 在线的 host 上自动创建 Claude Code session 处理请求，并将回复以飞书交互卡片实时流式返回。飞书侧完全无感，和普通聊天体验一致。

## 工作原理

```
飞书用户 ──消息──→ 飞书开放平台
                      │
                      │ WebSocket 长连接
                      ↓
              ┌─────────────────┐
              │  7x24 Host      │
              │  (装有 Claude Code)  │
              │                 │
              │  lark-bridge  │  ← Claude Code plugin
              │  (daemon 组件)  │
              │       │         │
              │       ↓         │
              │  Claude Code    │  ← Agent SDK 创建 session
              │  Session        │     自动加载本 plugin 的 hooks/skills
              │       │         │
              │       ↓         │
              │  hooks 系统     │  ← session/message 生命周期 hooks
              │  (aria-memory等)│
              └────────┬────────┘
                       │
                       ↓
              飞书交互卡片 (流式输出)
```

### 关键设计

- **Claude Code plugin**：安装在 host 上，包含 hooks、skills 和 daemon 组件
- **Daemon 组件**：plugin 的一部分，负责飞书 WebSocket 监听和 session 生命周期管理
- **Session 创建在 host 本地**：通过 Agent SDK 在 host 上创建 Claude Code session，session 自动加载已安装的 plugins（包括本插件）
- **飞书侧无感**：用户只需在飞书中发消息，无需安装任何客户端

## 插件结构

```
lark-bridge/                     # Claude Code plugin 根目录
├── .claude-plugin/
│   └── plugin.json                # 插件元数据
├── hooks/
│   ├── hooks.json                 # Claude Code hook 注册
│   └── session-start.sh           # SessionStart hook: 注入 daemon 状态上下文
├── skills/                        # Claude Code slash commands
│   ├── lark-bridge              # /lark-bridge — daemon 管理
│   ├── feishu-sessions            # /feishu-sessions — 查看活跃会话
│   └── feishu-setup               # /feishu-setup — 初始配置向导
├── service/                       # Daemon 组件
│   ├── src/
│   │   ├── index.ts               # Daemon 入口
│   │   ├── config.ts              # 配置加载 (Zod 校验)
│   │   ├── session-manager.ts     # 会话生命周期管理
│   │   ├── claude-bridge.ts       # Claude Agent SDK 封装
│   │   ├── feishu.ts              # 飞书 WebSocket 客户端
│   │   ├── streaming-card.ts      # 流式响应卡片
│   │   ├── progress-card.ts       # 思考/工具进度卡片
│   │   ├── hooks.ts               # Bridge hook 系统引擎
│   │   └── memory-wrapup.ts       # aria-memory transcript 导出
│   ├── package.json
│   └── tsconfig.json
├── config/
│   └── config.example.json        # 配置模板
└── scripts/
    ├── install.sh                 # 依赖安装 + 编译
    └── start.sh                   # Daemon 启动脚本
```

## 安装

在目标 host 上（需已安装 Claude Code）：

```bash
# 1. 安装插件依赖并编译 daemon
bash scripts/install.sh

# 2. 创建配置
cp config/config.example.json ~/.lark-bridge/config.json
# 编辑填入飞书应用凭证和 host 参数
```

插件通过 Claude Code 的 plugin 发现机制自动加载（`.claude-plugin/plugin.json`）。

## 配置

配置文件：`~/.lark-bridge/config.json`（可通过 `FEISHU_BRIDGE_CONFIG` 覆盖）。

```jsonc
{
  "feishu": {
    "appId": "cli_your_app_id",       // 飞书应用 App ID
    "appSecret": "your_app_secret",    // 飞书应用 App Secret
    "allowedSenders": ["ou_xxx"],      // 允许的用户 open_id（空=允许所有人）
    "allowedChats": []                 // 允许的 chat_id（空=允许所有群）
  },
  "claude": {
    "model": "sonnet",                 // Claude 模型
    "workspaceRoot": "~/workspace/lark-bridge",
    "additionalDirectories": [],
    "permissionMode": "plan"           // bypassPermissions | plan | default
  },
  "session": {
    "idleTimeoutMs": 1800000,          // 空闲超时 (默认 30 分钟)
    "maxDurationMs": 14400000          // 最大时长 (默认 4 小时)
  },
  "daemon": {
    "mode": "nohup",                  // "nohup" (默认) 或 "service" (systemd/launchd)
    "autoStart": false                 // 仅 mode=service 时生效：开机自启
  },
  "hooks": {
    "session": {
      "pre": [],                       // session 创建时
      "post": [                        // session 关闭时
        { "type": "aria-memory-wrapup" }
      ]
    },
    "message": {
      "pre": [],                       // 消息送入 Claude 前
      "post": []                       // Claude 回复完成后
    }
  },
  "log": {
    "level": "info"
  }
}
```

> `allowedSenders` 和 `allowedChats` 均为空时允许所有人（启动时会警告）。

## 使用

### 启动 daemon

`service.sh` 根据配置文件中 `daemon.mode` 决定运行方式：

```bash
bash scripts/service.sh start       # 启动
bash scripts/service.sh status      # 查看状态
bash scripts/service.sh stop        # 停止
bash scripts/service.sh restart     # 重启
```

#### daemon.mode = "nohup"（默认）

最简单的方式，`nohup` 后台运行。无崩溃重启，无开机自启。适合开发调试或短期使用。

#### daemon.mode = "service"

注册系统级服务，支持崩溃自动重启（5 秒冷却）：

```bash
# 先在 config.json 中设置 daemon.mode 为 "service"
bash scripts/service.sh install     # 注册服务（仅首次）
bash scripts/service.sh start       # 启动
bash scripts/service.sh uninstall   # 卸载服务
```

| 平台 | 机制 | 服务文件 |
|------|------|---------|
| Linux | systemd user service | `~/.config/systemd/user/lark-bridge.service` |
| macOS | launchd LaunchAgent | `~/Library/LaunchAgents/com.lark-bridge.daemon.plist` |

开机自启由 `daemon.autoStart` 控制，默认关闭。设为 `true` 后重新 `install` 即可生效。

> Linux 上如需用户未登录时也保持服务运行，执行 `loginctl enable-linger $USER`。

日志统一写入 `~/.lark-bridge/bridge.log`。

### 飞书侧

用户直接在飞书中向机器人发消息即可。支持：
- 私聊对话
- 群聊 @机器人
- 发送文本、富文本、图片、文件

### Claude Code 侧

在 Claude Code 中可通过 skills 管理：
- `/lark-bridge start|stop|status` — daemon 管理
- `/feishu-sessions` — 查看活跃会话列表
- `/feishu-setup` — 初始配置向导

SessionStart hook 会在每次 Claude Code 会话启动时注入 daemon 运行状态。

## 会话生命周期

1. 飞书消息到达 → daemon 的 WebSocket 收到
2. 安全校验（allowlist）
3. 查找该 chatId 的活跃 session，没有则通过 Agent SDK 创建新的 Claude Code session
4. `session.pre` hooks 触发
5. `message.pre` hooks 触发 → 消息推送给 Claude
6. Claude 流式处理 → 实时更新飞书交互卡片（思考进度 + 文本输出）
7. 回复完成 → `message.post` hooks 触发
8. 空闲超时 / 最大时长 / 错误 / 服务关停 → `session.post` hooks 触发 → session 关闭

每个 chatId 同一时刻只有一个 session。关闭后新消息自动创建新 session。

## Hook 系统

Daemon 在 session 和 message 生命周期提供 4 个 hook 插槽：

| 插槽 | 触发时机 |
|------|---------|
| `hooks.session.pre` | 新 session 创建时 |
| `hooks.session.post` | session 关闭时 |
| `hooks.message.pre` | 用户消息推送给 Claude 前 |
| `hooks.message.post` | Claude 回复完成后 |

### 内置 hook 类型

**`aria-memory-wrapup`** — session 关闭时导出 transcript 到 `~/.aria-memory/transcripts/`，注册 pending wrapup。默认在 `session.post` 中启用。

```json
{ "type": "aria-memory-wrapup" }
```

**`command`** — 执行 shell 命令，上下文通过环境变量传入（`HOOK_PHASE`、`HOOK_CHAT_ID`、`HOOK_CHAT_TYPE`、`HOOK_ROLE`、`HOOK_CONTENT` 等）。

```json
{ "type": "command", "command": "your-script.sh", "timeoutMs": 5000 }
```

不配置 `hooks` 字段时，默认行为：session 结束时执行 aria-memory-wrapup，其余为空。设置 `session.post: []` 可禁用。

## 前置条件

- 7x24 在线的 host
- Host 上已安装 Claude Code
- 飞书开放平台应用（启用 WebSocket 长连接模式 + `im.message.receive_v1` 事件订阅）

## 依赖

- `@anthropic-ai/claude-agent-sdk` — Claude Code session 创建
- `@larksuiteoapi/node-sdk` — 飞书 WebSocket + API
- `pino` — 结构化日志
- `zod` — 配置校验
