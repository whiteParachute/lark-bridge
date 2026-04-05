---
name: lark-bridge
description: |
  Manage the Feishu Bridge daemon. Start, stop, or check status of the
  background service that bridges Feishu chat to Claude Code sessions.
  TRIGGER when: user says "feishu bridge", "start feishu", "stop feishu",
  "飞书桥", "启动飞书", "停止飞书"
argument-hint: <start|stop|status|restart>
allowed-tools: [Bash, Read]
---

Manage the Feishu Bridge daemon based on the argument:

**start** (default if no argument):
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/start.sh
```

**stop**:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/stop.sh
```

**status**:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/status.sh
```

**restart**:
```bash
bash ${CLAUDE_PLUGIN_ROOT}/scripts/stop.sh && sleep 1 && bash ${CLAUDE_PLUGIN_ROOT}/scripts/start.sh
```

Report the result to the user. If the config file `~/.lark-bridge/config.json` doesn't exist, suggest running `/feishu-setup` first.
