---
name: manage-message-channels
description: Query or configure OneClaw messaging channels. Use whenever the user asks which channel accounts are configured or supported, or asks to connect, set up, authenticate, troubleshoot, or compare Telegram, Discord, WhatsApp, personal WeChat, or Feishu/Lark.
---

# Manage Message Channels

Keep inventory read-only and move every credential-bearing action into the OneClaw app's Channels form.

## Answer inventory questions

- Treat a missing `channels` object as the normal empty state, not an error.
- For configured accounts, run at most `openclaw channels list --json`. Do not narrate each check, guess Gateway config paths, request the full config, or scan source/package directories.
- Use this OneClaw setup catalog for normal capability questions: Telegram (`telegram`), Discord (`discord`), WhatsApp (`whatsapp`), personal WeChat (`wechat`), and Feishu/Lark (`feishu`).
- OneClaw app Chat is the current interface, not a configured external IM account.
- Only for explicit advanced Runtime diagnostics, use `openclaw channels list --all --json`, `openclaw plugins list --enabled --json`, or `openclaw channels capabilities --channel <id> --json`.

## Set up a channel

- Briefly explain prerequisites. Never ask the user to paste a token, secret, password, or QR payload into Chat, and never edit credentials with shell or Gateway tools.
- Send installation, authentication, employee binding, and status checking to the existing app form with `[在 OneClaw 中配置 <name>](#/channels?setup=<id>)`. Use only catalog ids above and answer in the user's language.
- Do not claim connectivity from a saved form alone. Distinguish saved, preparing, waiting for credentials or scan, verifying, connected, degraded, and failed states.
