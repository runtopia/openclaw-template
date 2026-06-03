# Setup Wizard i18n (Chinese/English) Design

> **Scope:** Add bilingual (zh-CN / en) support to the setup wizard (`setup.html`) with automatic browser language detection.
> **Approach:** Inline JS translation dictionary + Alpine.js reactive binding. Zero external dependencies.
> **Language switching:** Automatic via `navigator.language`, no manual UI toggle.

---

## 1. Requirements

### Functional Requirements

- **FR-1**: All user-facing text in `setup.html` is translatable to Chinese and English.
- **FR-2**: Language is automatically detected from `navigator.language` on first load.
- **FR-3**: Fallback to English if the detected language is not supported.
- **FR-4**: The `lang` attribute on the `<html>` tag reflects the active language.

### Non-Functional Requirements

- **NFR-1**: Zero additional HTTP requests (all translations inline).
- **NFR-2**: No build step required (vanilla JS, no bundler).
- **NFR-3**: Graceful degradation if JS is disabled (page still renders in English).

---

## 2. Architecture

### Translation System

A simple key-based dictionary stored in a `<script>` block within `setup.html`:

```javascript
const I18N = {
  'en': { /* all English strings */ },
  'zh': { /* all Chinese strings */ }
};
```

A helper function `t(key)` looks up the active language:

```javascript
function t(key) {
  return (I18N[lang] && I18N[lang][key]) || I18N['en'][key] || key;
}
```

### Language Detection

```javascript
const lang = (navigator.language || navigator.userLanguage || 'en')
  .toLowerCase()
  .startsWith('zh') ? 'zh' : 'en';
```

This detects `zh`, `zh-CN`, `zh-TW`, `zh-HK`, etc. as Chinese, everything else as English.

### Alpine.js Integration

- Add `lang: 'en'` to the Alpine data object.
- Add a `t(key)` method to the data object that returns the translated string.
- Replace all hardcoded text with `x-text="t('key')"` or `x-bind:placeholder="t('key')"`.
- For `<option>` elements and other places where `x-text` can't be used, use `x-html` or pre-render with JS.
- Set `<html :lang="lang">` reactively.

### Text Replacement Strategy

All hardcoded strings in `setup.html` will be extracted into the dictionary:

| Key | English | Chinese |
|-----|---------|---------|
| `title` | Personal AI Assistant | 个人 AI 助手 |
| `subtitle` | Configure your AI assistant in a few simple steps | 简单几步配置你的 AI 助手 |
| `status.loading` | Loading... | 加载中... |
| `status.configured` | Configured - open /openclaw | 已配置 - 打开 /openclaw |
| `status.notConfigured` | Not configured - run setup below | 未配置 - 在下方运行设置 |
| `openUi` | Open OpenClaw UI | 打开 OpenClaw 界面 |
| `openTerminal` | Open Terminal | 打开终端 |
| `setupComplete.title` | Setup Complete | 设置完成 |
| `setupComplete.desc` | Your OpenClaw instance is configured and running | 你的 OpenClaw 实例已配置并运行中 |
| `doctor.title` | Run Doctor | 运行诊断 |
| `doctor.desc` | Performs health checks and repairs broken configuration. Creates a backup before making changes. | 执行健康检查并修复损坏的配置。修改前会创建备份。 |
| `doctor.button` | Run Doctor | 运行诊断 |
| `doctor.running` | Running... | 运行中... |
| `pairing.title` | Approve Pairing | 批准配对 |
| `pairing.desc` | Grant DM access to users who have requested pairing on Telegram or Discord. | 为在 Telegram 或 Discord 上请求配对的用户授予私信权限。 |
| `pairing.button` | Approve Pairing | 批准配对 |
| `reset.title` | Reset Setup | 重置设置 |
| `reset.desc` | Deletes the config file so you can run onboarding again from scratch. | 删除配置文件，以便从头重新运行初始化设置。 |
| `reset.button` | Reset | 重置 |
| `step1.title` | Model & Authentication | 模型与认证 |
| `step1.desc` | Choose your AI provider and authentication method | 选择你的 AI 提供商和认证方式 |
| `providerGroup` | Provider Group | 提供商分组 |
| `authMethod` | Auth Method | 认证方式 |
| `apiKey` | API Key / Token | API 密钥 / 令牌 |
| `apiKey.placeholder` | Paste your API key or token | 粘贴你的 API 密钥或令牌 |
| `baseUrl` | Base URL | 基础 URL |
| `baseUrl.placeholder` | https://api.example.com/v1 | https://api.example.com/v1 |
| `baseUrl.openaiHint` | OpenAI-compatible base URL, e.g. ... | OpenAI 兼容的基础 URL，例如 ... |
| `baseUrl.anthropicHint` | Anthropic-compatible base URL, e.g. ... | Anthropic 兼容的基础 URL，例如 ... |
| `providerName` | Provider Name | 提供商名称 |
| `providerName.placeholder` | e.g. deepseek, anthropic | 例如 deepseek、anthropic |
| `providerName.hint` | Used as the key in ... Leave blank to auto-derive from base URL. | 用作 ... 中的键。留空则自动从基础 URL 派生。 |
| `vision.label` | Model supports vision / image input | 模型支持视觉 / 图像输入 |
| `vision.hint` | Adds ... to the model definition | 添加到模型定义中 |
| `model` | Model | 模型 |
| `model.placeholder` | e.g. openai/gpt-4.1, anthropic/claude-sonnet-4 | 例如 openai/gpt-4.1、anthropic/claude-sonnet-4 |
| `model.format` | Format: provider/model-name | 格式：provider/model-name |
| `wizardFlow` | Wizard Flow | 向导流程 |
| `flow.quickstart` | Quickstart | 快速开始 |
| `flow.advanced` | Advanced | 高级 |
| `flow.manual` | Manual | 手动 |
| `step2.title` | Channels | 渠道 |
| `step2.desc` | Connect messaging platforms (optional — can be added later) | 连接消息平台（可选 — 可稍后添加） |
| `channelHint` | 提示：除 Telegram / Slack 外... | (same, already Chinese) |
| `telegram.placeholder` | Bot token from @BotFather | 从 @BotFather 获取的 Bot 令牌 |
| `telegram.hint` | Message @BotFather on Telegram and run /newbot | 在 Telegram 上给 @BotFather 发送消息并运行 /newbot |
| `telegram.dmOpen` | Open — anyone can DM | 开放 — 任何人可私信 |
| `telegram.dmPairing` | Pairing — requires approval | 配对 — 需要批准 |
| `discord.placeholder` | Bot token from Developer Portal | 从开发者门户获取的 Bot 令牌 |
| `discord.hint` | Enable MESSAGE CONTENT INTENT in Bot → Privileged Gateway Intents | 在 Bot → 特权网关意图中启用 MESSAGE CONTENT INTENT |
| `feishu.appId` | App ID (cli_xxx) | 应用 ID (cli_xxx) |
| `feishu.appSecret` | App Secret | 应用密钥 |
| `whatsapp.desc` | QR code scan — no token required | 二维码扫描 — 无需令牌 |
| `webchat.desc` | Embeddable web chat widget | 可嵌入的网页聊天组件 |
| `dmAccess` | DM Access | 私信权限 |
| `step3.title` | Run Setup | 运行设置 |
| `step3.desc` | Review your configuration and start OpenClaw | 查看配置并启动 OpenClaw |
| `configSummary` | Configuration Summary | 配置摘要 |
| `config.provider` | Provider | 提供商 |
| `config.auth` | Auth | 认证 |
| `config.model` | Model | 模型 |
| `config.channels` | Channels | 渠道 |
| `config.none` | None | 无 |
| `runSetup` | Run Setup | 运行设置 |
| `runSetup.running` | Running... | 运行中... |
| `back` | Back | 返回 |
| `next` | Next | 下一步 |
| `pairingModal.title` | Approve Pairing | 批准配对 |
| `pairingModal.channel` | Channel | 渠道 |
| `pairingModal.channel.placeholder` | Select channel... | 选择渠道... |
| `pairingModal.code` | Pairing Code | 配对码 |
| `pairingModal.code.placeholder` | e.g. 3EY4PUYS | 例如 3EY4PUYS |
| `approve` | Approve | 批准 |
| `cancel` | Cancel | 取消 |
| `reset.confirm` | Reset setup? This deletes the config file so onboarding can run again. | 重置设置？这将删除配置文件以便重新运行初始化。 |
| `reset.button` | Reset | 重置 |
| `reset.hint` | Reset deletes the config file so you can rerun onboarding. Pairing approval grants DM access when dmPolicy=pairing. | 重置删除配置文件以便重新运行初始化。配对批准在 dmPolicy=pairing 时授予私信权限。 |
| `default` | Default | 默认 |
| `error.http` | Error: | 错误： |

### Dynamic Text in JS

The following strings are set dynamically in JS and also need translation:

- `status: 'Loading...'` → `status: this.t('status.loading')`
- `status: j.configured ? 'Configured - open /openclaw' : 'Not configured - run setup below'` → use translation keys
- `alert('Channel must be "telegram" or "discord"')` → translate
- `alert('Please enter a pairing code')` → translate
- `alert('✓ ' + msg)` → translate
- `alert('✗ Pairing failed: ' + msg)` → translate
- `confirm('Reset setup? ...')` → translate
- `alert('✗ Pairing failed: ' + String(e))` → translate

---

## 3. Data Flow

1. Browser loads `setup.html`
2. `<script>` block runs: detect language, define `I18N` dictionary
3. Alpine.js initializes `setupApp`
4. `setupApp` calls `this.detectLanguage()` in `init()`
5. All `x-text="t('key')"` bindings render in the detected language
6. `<html :lang="lang">` updates reactively

---

## 4. Error Handling

- If a translation key is missing, fall back to English.
- If English key is also missing, return the key itself (for debugging).
- `navigator.language` is unavailable (very old browsers): default to English.

---

## 5. Testing Plan

1. **Test Chinese detection**: Set browser language to `zh-CN`, verify all text is Chinese.
2. **Test English fallback**: Set browser language to `fr`, verify all text is English.
3. **Test `lang` attribute**: Inspect `<html>` tag, verify `lang="zh"` or `lang="en"`.
4. **Test dynamic text**: Verify status messages, alerts, and confirm dialogs are translated.
5. **Test step navigation**: Verify step titles and descriptions update correctly.
6. **Test form placeholders**: Verify input placeholders are translated.
7. **Test select options**: Verify `<option>` text is translated.

---

## 6. Implementation Notes

- The `t()` function must be a method on the Alpine data object (not a standalone function) so it can access `this.lang`.
- For `<option>` elements inside `<template x-for>`, the text is already dynamic (`x-text`), so translation can be handled by translating the source data (authGroups, authChoices) server-side, or by translating the labels in JS before rendering.
- Actually, for `<option>` elements, the simplest approach is to keep the labels in the data as-is (they come from the server in `/setup/api/status`), since those are provider names and auth method names which are typically not translated.
- The wizard flow options (`Quickstart`, `Advanced`, `Manual`) and DM policy options (`Open`, `Pairing`) are hardcoded in HTML and need translation.
- The `x-text` on the status span needs to be a computed property or method call.

### Handling `x-text` on status

Currently: `<span x-text="status" ...>`

Change to: `<span x-text="statusText()" ...>`

Where `statusText()` is a computed method that returns the translated status based on `this.configured`.

### Handling `x-text` on log

The log is a raw string that includes both static text and dynamic output. For simplicity, keep the log in English (it's primarily for debugging). Or, translate the static prefixes (`Running...`, `Resetting...`, etc.) and keep the dynamic output as-is.

### Option Translation

For `<option>` elements that are hardcoded:

```html
<!-- Before -->
<option value="quickstart">Quickstart</option>

<!-- After -->
<option value="quickstart" x-text="t('flow.quickstart')"></option>
```

For `<option>` elements rendered via `x-for` (auth groups, auth choices), the labels come from the server. These are technical identifiers (provider names, auth method names) and typically don't need translation. If they do, add a mapping in the translation dictionary.

### Alert/Confirm Translation

Replace all string literals in `alert()` and `confirm()` calls with `this.t('key')`.

---

## 7. File Changes

### `src/public/setup.html`

- Add `<html :lang="lang">` attribute binding.
- Add `I18N` dictionary in a `<script>` block before Alpine.js init.
- Add `lang` property to Alpine data object.
- Add `detectLanguage()` and `t(key)` methods to Alpine data object.
- Replace all hardcoded text with `x-text="t('key')"` or `x-bind:placeholder="t('key')"`.
- Replace dynamic status text with translated versions.
- Translate all `alert()`, `confirm()`, and `prompt()` strings.

---

## 8. Rollback Plan

If issues arise, revert `src/public/setup.html` to the previous version. The change is localized to a single file.
