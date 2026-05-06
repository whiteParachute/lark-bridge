# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在本仓库中工作时提供指引。

## 仓库概述

一个 Claude Code 插件，把飞书 (Lark) IM 桥接到 **Claude Code 或 Codex** 会话。整个插件在一棵目录树里包含三个关注点：

1. **TypeScript daemon** (`service/`) — 跑在 7×24 在线 host 上，持有飞书 WebSocket，按本 chat 当前默认后端创建会话。两种后端：`@anthropic-ai/claude-agent-sdk` 和 `@openai/codex-sdk`。
2. **Claude Code skills** (`skills/`) — `/lark-bridge`、`/feishu-sessions`、`/lark-setup`，在 Claude Code 内部用于管理 daemon。
3. **插件元数据 + hooks** (`.claude-plugin/`、`hooks/`) — `SessionStart` hook 在每次 Claude Code 会话启动时注入 daemon 状态。

daemon **不是**独立项目，而是插件的一个组件，与插件代码同仓发布。`plugin.json` 的 `postInstall` 在通过 Claude Code marketplace 安装插件时会执行 `scripts/install.sh` 完成构建。

注意"Claude Code 插件"指的是 lark-bridge 本身作为插件安装在用户机器上；"飞书侧后端"指的是 lark-bridge 调用的 LLM SDK（claude 或 codex），是两个不同的概念。

## 常用命令

所有 daemon 命令从仓库根目录运行：

```bash
bash scripts/install.sh          # npm install + tsc build (幂等)
bash scripts/service.sh start    # 启动 daemon (依据 config 中的 daemon.mode)
bash scripts/service.sh status
bash scripts/service.sh stop
bash scripts/service.sh restart
cd service && npm run build      # 仅 tsc — 当 src 比 dist 新时 start.sh 会隐式跑这个
cd service && npm run dev        # tsc --watch
```

仓库**没有测试套件、linter、formatter**。不要凭空发明这些命令。

`scripts/start.sh` 和 `scripts/service.sh` 在任何 `service/src/**/*.ts` 比 `service/dist/index.js` 新时都会自动重建。改完 TypeScript 后，重启 daemon 即可，不需要单独构建。

日志：`~/.lark-bridge/bridge.log`。状态快照（每 10 秒重写一次）：`~/.lark-bridge/status.json`。PID：`~/.lark-bridge/bridge.pid`。配置：`~/.lark-bridge/config.json`（可用 `LARK_BRIDGE_CONFIG` 环境变量覆盖）。

## 架构 — 跨文件的关键脉络

### 会话生命周期

`service/src/index.ts` 把 `FeishuClient`、`SessionManager` 和两个可选的内存调度器串起来。每条入站飞书消息：

1. `FeishuClient` (`feishu.ts`) — Lark SDK `WSClient`，把 `text` / `post` / `image` / `file` 解码为 `FeishuMessage`。带一个 **WS 看门狗**：扫描 SDK logger 输出里的失败模式 (`/timeout/`、`/unable to connect/`、`ECONNRESET` 等)，连续失败 N 次或静默超时后强制重连。看门狗是**唯一**恢复路径，否则 SDK 会静默死亡。
2. `SessionManager.handleMessage` (`session-manager.ts`) — 热加载配置（这样改 allowlist 不用重启 daemon），校验 `allowedSenders`/`allowedChats`，跑 per-chat 令牌桶限流（5 token，1/12s 补充）。
3. **Bot 命令分流** —— `parseCommand(msg.text)` 识别消息首词；命中 `/new`、`/provider`、`/hold`、`/state` 时由 `handleCommand` 在 bridge 内处理，**不进后端 LLM**。其他 `/xxx`（含 Claude Code 自身的 slash command）原样透传。
4. 路由到该 chat 的 `Session`。同一 chatId 的并发 create 用 `creatingChats` map 守护。新 chat 的默认后端来源优先级：`ChatStateStore.getBackend(chatId)`（持久值）> `config.defaultBackend`。
5. `Session.backend` 是 `Backend` 接口实例，由 `createBackend(kind)` 工厂产出（`backend/index.ts`）。两种实现：
   - `ClaudeBackend` (`backend/claude.ts`) — 封装 `@anthropic-ai/claude-agent-sdk` 的 `query()`。`settingSources: ['project','user']` 让安装的插件（aria-memory）自动加载。`canUseTool` 始终 allow —— bridge 模式没有交互终端。
   - `CodexBackend` (`backend/codex.ts`) — 封装 `@openai/codex-sdk` 的 `Thread.runStreamed()`。事件粒度比 claude 粗（`item.completed` / `turn.completed`），适配为统一 `StreamMessage` 时只能产出粗粒度 `text_delta`，飞书"打字机"流式效果会退化为整段一次到位 —— codex 协议层面的 trade-off，非 lark-bridge bug。
6. 后端流式事件分发到两类卡片：
   - `ProgressCardController` — 接 `thinking_delta` / `tool_use_start` / `tool_use_end`，`complete()` 后 15 秒自动删除。
   - `StreamingCardController` — 接 `text_delta`，`turn_complete` 时定稿。卡片 patch 失败则降级为纯文本。
7. 单 turn 归属由 `turnId` 跟踪（每个 `turn_complete` 后递增）。当新用户消息在 turn 中途到达时，`handleMessage` 会等待上一个 turn 的 `turnCompletePromise`（带 30 秒安全超时）后再切换卡片。这样可以避免 `turn_complete` 被错误归属到新卡片。
8. 空闲计时器 (`session.idleTimeoutMs`) 和最长时长计时器 (`session.maxDurationMs`) 都调用 `closeSession`，依次 `interrupt()` → `end()` 后端 query，跑 `session.post` hooks，然后移除会话。**`session.held === true`（用户用了 `/hold`）时这两个计时器都不会安装** —— `resetIdleTimer` 直接 return，`createSession` 跳过 max timer。

每个会话在创建时 `structuredClone` 一份配置 —— 后续热加载不影响在飞会话，只有下一条消息路径才看到新配置。

### Backend 抽象

- `service/src/backend/index.ts` 定义 `Backend` 接口、`BackendKind` 枚举（`'claude' | 'codex'`）、`StreamMessage` 协议、`createBackend(kind)` 工厂。
- `Backend` 接口形态故意与原 `ClaudeBridge` 一一对应：`start / pushMessage / getTurnId / interrupt / end / waitForCompletion`。SessionManager 不需要知道底层是哪个 SDK。
- `StreamMessage` 类型是事实上的统一协议；新后端的事件适配在自己的 backend 类里完成，外部代码不变。
- Codex 后端的特殊点：(a) 图片输入暂未桥接（SDK 的 `Input` 联合类型只接受 `text` / `local_image`-by-path，不接 base64；pushMessage 收到 images 会丢弃并 warn，未来需要桥接时把 base64 落 tmp 文件再传 path）；(b) `interrupt()` 通过 `AbortController` + `TurnOptions.signal` 实现真正的中断；(c) 鉴权依赖 codex CLI 自身（`codex login` / `CODEX_API_KEY`），lark-bridge 配置文件不管；(d) `startThread` 默认 **YOLO**：`approvalPolicy: 'never'` + `sandboxMode: 'danger-full-access'` + `networkAccessEnabled: true`，与 claude 后端 `canUseTool: allow` 等价的"全放行"——可跑 systemctl/sudo、跨目录 git/npm。安全完全下沉到 `feishu.allowedSenders` / `feishu.allowedChats`，启动时白名单宽松会 warn（见 `index.ts`）。

### Bot 命令体系

- `service/src/commands.ts` —— 解析消息文本。仅当首行首词命中白名单 `{new, provider, hold, state}` 时返回 `BotCommand`，否则返回 null（透传给后端）。这样保留了 Claude Code 自身的 `/init`、`/review` 这些 slash command。
- `SessionManager.handleCommand` —— dispatch。`/new` 与 `/provider` 都走 `commandResetSession` 公共路径：关闭当前会话 → 用指定后端开新会话 → 可选 inline prompt 作为首条消息。`/provider` 还会持久化默认后端到 `chat-state.json`。
- `deliverUserMessage` —— 旁路（仅 `commandResetSession` 用），把构造的 `continuationMsg` 直接送进会话路径，**跳过 allowlist / rate-limit / parseCommand**，避免无限递归。原 `/new`、`/provider` 触发消息已在 `handleMessage` 入口过 allowlist。
- `/hold` —— 设 `session.held = true`，清掉两个 timer。仅在会话被销毁时（`/new`、`/provider`、daemon 关停）解除。
- `/state` —— 纯本地读 Session 字段 + `progressCard.getSnapshot()`，**不调 LLM**，发独立简单卡片，不污染当前 turn 的 streaming card。

### 持久化默认后端

- `service/src/chat-state.ts` —— `ChatStateStore` 类，文件 `~/.lark-bridge/chat-state.json`。
- 启动时同步加载，`/provider` 时同步写入（tmp+rename 原子）。
- 仅存 per-chat 默认后端，不存会话上下文 —— 切换后端不继承上下文是设计意图。

### aria-memory 集成（一个旋钮模型）

**是否集成由 `hooks.session.post` 是否包含 `{ type: 'aria-memory-wrapup' }` 决定**，没有单独的 enable 开关。

- 列了 → opt-in：会话关闭时把真 SDK transcript 路径登记到 `<memoryDir>/meta.json.pendingWrapups`
- 没列 → 啥也不做，daemon 不碰 aria-memory 任何文件

daemon **不再跑** wrapup / sleep 调度器（已在重构中移除）。`PendingWrapupConsumer`、`GlobalSleepScheduler`、`memory-maintenance.ts` 这三个文件都不在了。把这两件事完全交给 primary host 上的 claude/codex CLI 启动时的 aria-memory SessionStart hook 处理 —— 避免 lark-bridge 与 primary 抢 sleep 执行权（aria-memory 用 `.role.<source>=primary` 网点 sleep）。

老配置字段 `ariaMemory.enabled` / `ariaMemory.variant` / `globalSleep.*` / `wrapupConsumer.*` 已废弃，parser 用 `z.looseObject()` 容忍它们，并在 `warnDeprecatedFields` 里 console.warn 一次提醒迁移。

### Hook 系统（daemon 内部，区别于 Claude Code hooks）

`hooks.ts` 跑 `config.json` 里定义的 `session.pre/post` 和 `message.pre/post`。两种内置类型：

- `aria-memory-wrapup` (`memory-wrapup.ts`) —— 按 `backendKind` 解析真 SDK transcript 路径，append 到 `meta.json.pendingWrapups`：
  - **claude**：`~/.claude/projects/<encodedCwd>/<sessionId>.jsonl`，其中 `encodedCwd = '-' + cwd.replaceAll('/', '-')`，`sessionId` 来自 `system/init` 事件。`existsSync` 校验文件存在才注册。
  - **codex**：no-op。`~/.codex/hooks.json` 全局 SessionEnd 在 codex CLI 子进程结束时已自动登记 rollout，bridge 这边再做就重复。
  - 没装 aria-memory（vault 目录不存在）→ debug log 后静默 skip，不打扰用户。
- `command` —— 跑 shell 命令，传入 `HOOK_PHASE`、`HOOK_CHAT_ID`、`HOOK_CHAT_TYPE`、`HOOK_ROLE`、`HOOK_CONTENT`、`HOOK_SESSION_ID`、`HOOK_BACKEND`、`HOOK_REASON`、`HOOK_TRANSCRIPT_LENGTH` 等环境变量。

`SessionHookContext` 在 session.post 阶段会带 `backendKind` + `cwd` + `sessionId`，wrapup hook 全靠这三个字段解析路径。

不要把这些和 `hooks/hooks.json` 里的 Claude Code 插件 hook 混淆 —— 那个只在 Claude Code 会话启动时跑，在用户的机器上，用来展示 daemon 状态。

### Daemon 模式（nohup vs service）

`config.json → daemon.mode`：
- `nohup`（默认）—— `scripts/service.sh` 和 `start.sh` 后台跑 `node`，PID 写文件。无 restart，无开机自启。
- `service` —— `service.sh install` 写 systemd user unit (Linux) 或 launchd LaunchAgent plist (macOS)，由 `systemctl --user` / `launchctl` 管理。`daemon.autoStart: true` 启用开机/登录启动。

`start.sh` 和 `stop.sh` 都会读 `daemon.mode` 并据此分发给 `service.sh` —— 不论后端是哪个，入口只有一个。

### 子进程调用约定

两个调度器 spawn `claude -p` 都用 `execFile`（不走 shell），不是 `exec`。prompt argv 里有 `JSON.stringify` 来的换行；走 `/bin/sh -c` 会把 `\n` 变成字面量反斜杠-n。如果新增带换行或引号的 prompt spawn，照搬这个模式。

### 重试 helper

`retry.ts` 提供 `withRetry(fn, { label })`。所有飞书 API 调用（`sendMessage`、`addReaction`、card patch、文件下载）都走这个。新增 Lark API 调用时不要绕过 —— SDK 限流激进，瞬时 5xx 很常见。
