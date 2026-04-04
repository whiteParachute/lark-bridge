---
name: feishu-sessions
description: |
  List active Feishu Bridge sessions. Shows chat IDs, duration, message count,
  and session state for all active conversations.
  TRIGGER when: user says "feishu sessions", "飞书会话", "active sessions"
allowed-tools: [Bash, Read]
---

Read and display the Feishu Bridge session status:

```bash
cat ~/.feishu-bridge/status.json 2>/dev/null || echo '{"error": "Bridge not running or no status file"}'
```

Format the output as a readable table showing:
- Chat ID (abbreviated)
- Chat type (p2p/group)
- Duration (how long the session has been active)
- Messages (count)
- State (active/closing)
- Last activity (relative time)

If no sessions are active, say so. If the bridge isn't running, suggest `/feishu-bridge start`.
