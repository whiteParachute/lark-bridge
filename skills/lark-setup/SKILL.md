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

## Step 2: Claude Settings

Ask the user to choose:

1. **Claude model** — present options:
   - `sonnet` (Recommended) — balanced speed and capability
   - `opus` — most capable, slower
   - `haiku` — fastest, lighter tasks

2. **Permission mode** — present options:
   - `plan` (Recommended) — Claude proposes actions, user approves
   - `bypassPermissions` — fully autonomous (show warning)
   - `default` — standard Claude Code permissions

3. **Workspace root** — text input with default `~/workspace/lark-bridge`. This is where per-chat working directories are created.

4. **Additional directories** — text input, comma-separated paths. Empty to skip.

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

## Step 5: Hook Configuration

Ask the user:

1. **Enable aria-memory integration?** — present options:
   - **Yes** (Recommended) — export transcripts to aria-memory on session close
   - **No** — disable memory integration

2. **Add custom hooks?** — present options:
   - **No** (Recommended) — use defaults
   - **Yes** — ask for shell command to run (and which phase: session.pre / session.post / message.pre / message.post)

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
