---
name: feishu-setup
description: |
  Configure Feishu Bridge credentials and install dependencies.
  Use when first setting up the bridge or updating Feishu app credentials.
  TRIGGER when: user says "feishu setup", "configure feishu", "飞书配置"
allowed-tools: [Bash, Read, Write, Edit]
---

Help the user configure the Feishu Bridge service.

## Steps

1. Ask the user for their Feishu Bot credentials:
   - `appId` (飞书应用 App ID, starts with `cli_`)
   - `appSecret` (飞书应用 App Secret)

2. Optionally ask for:
   - `claude.model` — Claude model to use (default: `sonnet`)
   - `session.idleTimeoutMs` — idle timeout in ms (default: `1800000` = 30 min)

3. Write the config to `~/.lark-bridge/config.json`:
```json
{
  "feishu": { "appId": "...", "appSecret": "..." },
  "claude": {
    "model": "sonnet",
    "workspaceRoot": "~/workspace/lark-bridge"
  },
  "session": {
    "idleTimeoutMs": 1800000,
    "maxDurationMs": 14400000
  },
  "log": { "level": "info" }
}
```

4. Run the install script:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/install.sh
```

5. Tell the user they can now start the bridge with `/lark-bridge start`.
