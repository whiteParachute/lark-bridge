---
name: lark-setup
description: |
  Interactive setup wizard for lark-bridge. Guides through Feishu app credentials,
  Claude model selection, session settings, daemon mode, and hook configuration.
  TRIGGER when: user says "feishu setup", "configure feishu", "飞书配置",
  "lark setup", "lark-bridge setup", "配置飞书桥"
argument-hint: "[reconfigure]"
allowed-tools: [Bash, Read, Write, Edit, AskUserQuestion]
---

# lark-bridge Interactive Setup

Guide the user through configuring lark-bridge step by step. Use `AskUserQuestion` for every choice — never assume defaults without asking.

## Step 0: Detect Existing Configuration

```bash
cat ~/.lark-bridge/config.json 2>/dev/null
```

- If config exists, show current settings summary and ask:
  - **Reconfigure from scratch** — start fresh
  - **Update specific settings** — ask which section to modify (feishu / claude / session / daemon / hooks)
- If no config exists, proceed to Step 1.

## Step 1: Feishu App Credentials

Ask for the following using `AskUserQuestion` text input:

1. **App ID** — 飞书应用 App ID (starts with `cli_`)
2. **App Secret** — 飞书应用 App Secret

Validate:
- App ID must start with `cli_` and be non-empty
- App Secret must be non-empty

Then ask about access control:

3. **Access control mode** — present options:
   - **Allow specific users** — enter comma-separated open_ids (ou_xxx)
   - **Allow specific chats** — enter comma-separated chat_ids
   - **Allow all** — no restrictions (show warning: all Feishu users can interact)

## Step 2: Backend Settings

### 2a. Default backend

Ask:

1. **默认后端** — 哪个 LLM 后端为新 chat 的默认值（用户可在飞书侧用 `/provider <claude|codex>` 随时切换）：
   - `claude` (Recommended) — Claude Code via `@anthropic-ai/claude-agent-sdk`
   - `codex` — OpenAI Codex via `@openai/codex-sdk`（需要预先 `codex login` 或设置 `CODEX_API_KEY`）

### 2b. Claude backend settings

1. **Claude model** — present options:
   - `sonnet` (Recommended) — balanced speed and capability
   - `opus` — most capable, slower
   - `haiku` — fastest, lighter tasks

2. **Permission mode** — present options（提示用户：`canUseTool` 回调对所有工具永远 allow，所以不论选哪档 Claude 实际都能跑任意命令；这里更多是模型的行为风格选择）：
   - `auto` (Recommended) — Claude 主动执行，与 codex 后端 YOLO（`approvalPolicy: never` + `sandboxMode: danger-full-access`）能力对等
   - `acceptEdits` — 模型行为偏向自动接受编辑、其它先问（bridge 模式没人答，多数情况下也直接执行）
   - `plan` — 模型仅提议方案不直接动手（bridge 模式没人按"确认"，会卡住，不建议）
   - `bypassPermissions` — 显式跳过权限层（show warning）
   - `default` — 标准 Claude Code 权限

3. **Workspace root** — text input with default `~/workspace/lark-bridge`. This is where per-chat working directories are created. **Codex sessions share the same workspace** —— per-chat 子目录由两个后端共用。

4. **Additional directories** — text input, comma-separated paths. Empty to skip.

### 2c. Codex backend settings (only if codex was selected as default OR user wants to use it later)

1. **Codex model** — text input with default `gpt-5-codex`. 留空使用 SDK 默认。

提示用户：codex 鉴权不在配置文件里设置——需要在 host 上预先运行 `codex login` 完成 OAuth，或导出 `CODEX_API_KEY` 环境变量。

## Step 3: Session Settings

Ask the user to choose:

1. **Idle timeout** — present options:
   - `15 minutes`
   - `30 minutes` (Recommended)
   - `1 hour`
   - Custom — text input in minutes

2. **Max session duration** — present options:
   - `2 hours`
   - `4 hours` (Recommended)
   - `8 hours`
   - Custom — text input in hours

## Step 4: Daemon Mode

Ask the user to choose:

1. **Daemon mode** — present options:
   - `nohup` (Recommended for development) — simple background process, no auto-restart
   - `service` — system service with crash recovery (systemd on Linux, launchd on macOS)

2. If `service` selected, ask:
   - **Auto-start on boot** — Yes / No (default: No)

## Step 5: Memory & Hook Configuration

### 5a. aria-memory Integration

Ask:

1. **你机器上是否安装了 aria-memory？**（claude 或 codex 形态任一）—— 选项：
   - **No**（默认）—— 没装，或装了但不想集成。lark-bridge 跑成纯 feishu↔LLM bridge，不碰 aria-memory。
   - **Yes** —— 装了想集成。每次 feishu 会话关闭时把真 SDK transcript 路径登记到 `~/.aria-memory/meta.json.pendingWrapups`，**primary host 上的 claude/codex CLI 启动时自动 drain**（lark-bridge 不处理 wrapup/sleep 本身）。

2. 如果选 **Yes**，再问：
   - **Memory directory** —— 默认 `~/.aria-memory`，按需修改（aria-memory vault 的位置）。

Config mapping:
- **No** → `hooks.session.post: []`，不写 `ariaMemory` 块（用默认 `~/.aria-memory`）。
- **Yes** → `hooks.session.post: [{ "type": "aria-memory-wrapup" }]`；如自定义 vault 路径再加 `"ariaMemory": { "memoryDir": "<path>" }`。

> 旧版本支持的 `ariaMemory.enabled` / `ariaMemory.variant` / `globalSleep.*` / `wrapupConsumer.*` 字段已**废弃**，写在配置里也会被忽略（启动时打一行 warn）。daemon-side schedulers 已移除，sleep 由 primary CLI 处理。

### 5b. Custom Hooks

**Add custom hooks?** —— 选项：
   - **No**（推荐）—— 仅按 5a 选择的 aria-memory hook
   - **Yes** —— 让用户提供 shell 命令 + 触发阶段（session.pre / session.post / message.pre / message.post）。命令通过环境变量拿到上下文（HOOK_PHASE / HOOK_CHAT_ID / HOOK_BACKEND / HOOK_SESSION_ID 等）。

## Step 6: Write Configuration

Assemble the final config.json from all collected answers. Convert timeout/duration selections to milliseconds.

```bash
mkdir -p ~/.lark-bridge
```

Write to `~/.lark-bridge/config.json` using the Write tool. Pretty-print with 2-space indent.

Show the user a summary of the complete configuration.

## Step 7: Verify & Next Steps

Check if daemon is already compiled:

```bash
ls ${CLAUDE_PLUGIN_ROOT}/service/dist/index.js 2>/dev/null && echo "BUILD_OK" || echo "BUILD_NEEDED"
```

If not compiled, run:

```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/install.sh
```

Then tell the user:
- Configuration saved to `~/.lark-bridge/config.json`
- To start the daemon: `/lark-bridge start`
- To check status: `/lark-bridge status`
- To reconfigure later: `/lark-setup reconfigure`

If daemon mode is `service`, remind them to run:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/service.sh install
```
