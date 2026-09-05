# Weixin ClawBot channel

Zero3 Pilot can connect directly to Tencent's official Weixin ClawBot/iLink service without embedding OpenClaw as a second agent runtime.

The protocol implementation follows the public `Tencent/openclaw-weixin` HTTP/JSON contract:

- QR login: `ilink/bot/get_bot_qrcode` + `ilink/bot/get_qrcode_status`
- receive: `ilink/bot/getupdates`
- reply: `ilink/bot/sendmessage`
- authentication: `AuthorizationType: ilink_bot_token` + `Authorization: Bearer <token>`

Only text and WeChat-provided voice transcripts are routed into Zero3 Pilot in this first version. Media upload/download remains a future extension.

## Security model

This is a personal-computer control channel, so inbound messages are fail-closed:

1. The WeChat user who scans the login QR becomes the bound owner (`ilink_user_id`).
2. Messages from any other sender are ignored.
3. Owner messages are ignored unless they explicitly start with `/pilot`.
4. `/pilot` is treated as an explicit user command and is submitted to the local Pilot Node as a normal durable Agent job; the Node remains the runtime authority.
5. Weixin credentials are stored only in the local Zero3 Pilot data directory and are never printed in status output or logs.

This means simply receiving a normal WeChat conversation cannot accidentally invoke Codex/Claude/Hermes.

## Connect

From the installed Start Menu choose **连接微信 ClawBot**, or run:

```powershell
zero3-pilot-weixin.exe login
```

The command requests a QR code from Tencent, opens the QR URL, waits for phone confirmation, handles optional pairing-code verification, and persists the resulting bot token locally.

Check status:

```powershell
zero3-pilot-weixin.exe status
```

Start the channel (Codex by default):

```powershell
zero3-pilot-weixin.exe run
```

Or choose a default Agent:

```powershell
zero3-pilot-weixin.exe run hermes
```

You can also set `ZERO3_WEIXIN_AGENT=claude|codex|hermes`.

## Commands from WeChat

```text
/pilot summarize my current task
/pilot codex inspect the current project
/pilot claude review this design
/pilot hermes check the automation state
```

The connector submits the command to the local Node, waits on the durable Job record, and sends the final result back through the same Weixin conversation context token.

Disconnect and remove local credentials:

```powershell
zero3-pilot-weixin.exe disconnect
```

## Local Node requirement

The channel talks only to the loopback Pilot Node (`http://127.0.0.1:8790` by default). The desktop normally starts that Node automatically. Override only for local development with `ZERO3_PILOT_NODE_URL`.

## Upstream relationship

Zero3 Pilot does not vendor the OpenClaw runtime or Tencent plugin source. It implements the published iLink wire contract behind a Zero3-owned provider, consistent with the project's upstream policy: absorb useful capability seams without introducing another agent loop.
