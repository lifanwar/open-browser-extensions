<p align="center">
  <img src="icons/icon-128.png" width="112" height="112" alt="Open Browser Agent logo">
</p>

<h1 align="center">Open Browser Agent</h1>

<p align="center">
  <strong>Bring your own model. Let it work inside your browser.</strong><br>
  A clean-source Chrome side-panel agent for reading pages, operating interfaces, inspecting network traffic, managing cookies, and researching the web.
</p>

<p align="center">
  <a href="#-core-features">Core Features</a> •
  <a href="#-built-in-tools">Built-in Tools</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-configuration">Configuration</a> •
  <a href="#-privacy--security">Privacy & Security</a>
</p>

<p align="center">
  <img alt="Chrome 116+" src="https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&logoColor=white">
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-5F6368">
  <img alt="OpenAI-compatible" src="https://img.shields.io/badge/API-OpenAI--compatible-10A37F">
  <img alt="No build step" src="https://img.shields.io/badge/Build-none-7C3AED">
  <img alt="GPL-3.0 license" src="https://img.shields.io/badge/License-GPL--3.0-blue">
</p>

<table align="center">
  <tr>
    <td align="center"><img src="docs/images/chat-dark.png" width="140" alt="Agent chat in dark theme"></td>
    <td align="center"><img src="docs/images/chat-light.png" width="140" alt="Agent chat in light theme"></td>
    <td align="center"><img src="docs/images/conversations.png" width="140" alt="Local conversation manager"></td>
    <td align="center"><img src="docs/images/browser-tools.png" width="140" alt="Browser and security tool switches"></td>
  </tr>
</table>

---

## Open AI, directly in the browser

Open Browser Agent turns Chrome's side panel into an AI workspace that can understand the active page and take verified actions through native browser tools. Connect any compatible chat endpoint, keep control of sensitive capabilities, and inspect every agent step as it runs.

## ✨ Core Features

- **Bring your own model** — Connect any OpenAI-compatible API and configure the model, temperature, prompt, streaming, and tool limits.
- **Browser automation** — Read pages, click, fill forms, navigate, switch tabs, scroll, press keys, and run JavaScript.
- **Live agent activity** — View provider reasoning, tool calls, results, and execution status in real time.
- **Mid-run steering** — Add new instructions while the agent is still working.
- **Network inspection** — Capture and filter requests, headers, payloads, status data, and response bodies.
- **Cookie tools** — View, export, create, import, update, or delete current-page cookies.
- **Web search and extraction** — Use SEARCH and EXTRACT through direct or 9Router-compatible endpoints.
- **Context compaction** — Keep full chats locally while sending compact context to the model.
- **Multiple conversations** — Create, switch, auto-title, save, and delete chats.
- **Rich response rendering** — Stream Markdown, highlighted code, copy buttons, and scrollable tables.
- **Light and dark themes** — Use system, light, or dark appearance.
- **Clean source code** — Dependency-free HTML, CSS, and JavaScript with no bundling or obfuscation.

## 🧰 Built-in Tools

| Area | Tools | Capability |
| --- | --- | --- |
| Page understanding | `read_page` | Returns visible text and interactive elements with stable references. |
| Interaction | `click`, `fill`, `select_option`, `press_key` | Operates forms and page controls through element references. |
| Navigation | `scroll_page`, `wait`, `navigate` | Handles long pages, asynchronous updates, and HTTP/HTTPS navigation. |
| Tabs | `list_tabs`, `switch_tab` | Finds and changes the active agent target within the current window. |
| Advanced page access | `executeScript` | Runs JavaScript in the page's main world for complex DOM or runtime tasks. |
| Network debugging | `network_start`, `network_get`, `network_clear`, `network_stop` | Captures and inspects recent DevTools Network activity. |
| Cookie debugging | `cookies_list`, `cookies_set`, `cookies_import`, `cookies_delete`, `cookies_delete_all` | Reads, exports, writes, imports, or removes current-page cookies. |
| Web research | `web_search_tool` | Uses `SEARCH` for discovery and `EXTRACT` for known URLs. |

Search and cookie-write tools are not advertised to the model until their corresponding switches are enabled.

## 🚀 Quick Start

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked** and choose the project folder.
5. Reload any browser tabs that were already open.
6. Open the side panel, go to **Settings**, and enter your API configuration.

Use the extension button or press `Ctrl+M` on Windows/Linux and `Command+M` on macOS.

### Minimum chat configuration

```text
Base URL: https://api.openai.com/v1
API key:  <your key>
Model:    <tool-capable model>
```

The extension sends requests to:

```text
POST <base-url>/chat/completions
Authorization: Bearer <api-key>
```

## ⚙️ Configuration

### Chat connection

Configure the Base URL, API key, model, temperature, maximum tool steps, response streaming, and an optional additional system prompt.

The response parser supports standard JSON, OpenAI-style SSE, NDJSON, reasoning fields, streamed tool calls, BOM-prefixed payloads, control bytes, and common proxy envelopes.

### Search connection

Enable **Web search tool**, then choose one connection mode:

- **Direct endpoints** — Provide separate Search and Fetch URLs.
- **9Router-compatible** — Provide one base URL; the extension derives `/search` and `/web/fetch`.

Search and Fetch can use separate API keys and models. Search supports Web or News mode with 1–10 results. Fetch can request Markdown, text, or HTML.

### Browser tool controls

- **Auto-start Network** — Begin capture when a page is first read.
- **Capture response bodies** — Store textual response bodies for inspection.
- **Raw values for current host** — Reveal matching Cookie, Authorization, token, and body values only for the active host.
- **Allow cookie paste/delete** — Enable cookie write, import, and delete tools.

## 🧠 Context and Agent Behavior

Long conversations remain complete in local history. When model-facing context becomes large, older completed turns are summarized into per-conversation memory while recent messages remain verbatim. If compaction is unsupported or fails, the run falls back without blocking the conversation.

During an active run, new user instructions are queued and applied at safe boundaries. Completed actions remain checkpoints; unfinished tool calls can be skipped so the model can replan instead of blindly continuing an outdated plan.

## 🔐 Privacy & Security

- Settings, conversations, compacted memory, and appearance are stored in the local Chrome profile.
- API credentials are encrypted with AES-256-GCM. Ciphertext is stored in `chrome.storage.local`; the non-extractable encryption key is stored in extension IndexedDB.
- Credential values are redacted from agent events and error output where possible.
- Sensitive Network values remain hidden by default and require an explicit current-host switch.
- Cookie write tools require explicit opt-in.
- The extension only displays reasoning or thinking text returned by the configured provider. It does not extract hidden model reasoning.

Prompts, selected page content, tool results, search queries, fetched URLs, cookies requested by the user, and captured Network data may be sent to the endpoints you configure. Review the provider's privacy policy and enable sensitive tools only when needed.

This extension requires broad browser permissions because its core purpose is page automation and debugging. Use it only on pages and accounts you are authorized to inspect or control.

## 🧪 Development

No build step is required. Load the source folder directly as an unpacked extension.

Run the regression checks with:

```bash
npm run check
```

The test suite covers credential storage, browser-agent behavior, context compaction, and human-in-the-loop steering.

## 📄 License

Licensed under the [GPL-3.0 License](LICENSE).
