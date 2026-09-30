# Feishu connector

Turn Feishu (or Lark) chats into OpenMausBot surfaces: each saved app becomes
one bot identity in Feishu, and messages sent to it run on your own OpenMausBot
bots. No public callback URL is needed at any point — events arrive over a
WebSocket long connection, so a laptop behind NAT works.

## How it fits

```
Feishu app (scan-created) ──WebSocket long connection──▶ feishu-connector
                                                            │  HTTP (loopback or paired)
                                                            ▼
                                                   OpenMausBot harness ──▶ agent CLIs
```

The connector is a separate small process (`scripts/feishu-connector.ts`).
It reuses the MCP server's discovery and authentication: `OPENMAUSBOT_URL`,
`OMB_PORT`, or `OPENMAUSBOT_TOKEN`, exactly as documented in
[MCP server setup](mcp-server.md). One Feishu chat maps to one fresh bot
thread ("Feishu <chat id>"), so the bot's own sidebar thread stays untouched.

## Scan to connect

```sh
pnpm feishu scan              # Feishu; add --lark for Lark
pnpm feishu start --bot Ops   # bridge chats to the bot named Ops
```

`scan` prints a QR code. Scanning it with the Feishu mobile app creates a
PersonalAgent app and — via the `addons` payload mounted on the QR URL —
automatically subscribes `im.message.receive_v1` and requests `im:message`.
The open platform hands back `client_id` / `client_secret`, which land in
`~/.openmausbot/feishu-connector.json` (mode 0600 on Unix). `--bot NAME`
binds the app to one bot up front; otherwise pass `--bot` at `start`.

In Feishu, direct messages always reach the bot; in group chats the bot
answers when it is @-mentioned.

## Commands

| command | what it does |
|---|---|
| `pnpm feishu scan [--lark] [--bot NAME]` | print the QR, save the app it creates |
| `pnpm feishu list` | show saved apps and their bot bindings |
| `pnpm feishu remove --app APP_ID` | forget one saved app |
| `pnpm feishu start [--bot NAME] [--app ID]` | open the long connection(s) and bridge |

Approvals still happen in OpenMausBot: when a bot needs an Allow/Deny
decision mid-turn, the connector's wait ends with a pointer back to the app
rather than granting anything from chat.

## Notes and limits

- Text messages only (v1). Images, files, and voice notes are ignored.
- Replies are sent as plain text; markdown renders literally.
- One app maps to one bot. Create several apps (one scan each) to put
  several bots in Feishu.
- The connector must keep running to receive events — run it under a service
  manager for always-on use, or pair a phone for approvals on the go.
