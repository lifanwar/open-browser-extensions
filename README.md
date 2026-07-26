# Open Browser Agent

A clean, non-obfuscated Chrome Manifest V3 browser agent with a Merlin-style side panel, your own OpenAI-compatible endpoint, native function tools, streaming, conversations, reasoning panels, and dark mode.

## Highlights

- Clean HTML, CSS, and JavaScript source with no bundler or minification.
- OpenAI-compatible `POST /chat/completions` integration.
- Native `tools` / `tool_calls` browser-agent loop.
- SSE and NDJSON streaming with incremental answer rendering.
- Provider reasoning trace support, hidden behind a collapsible button by default.
- Multiple locally stored conversations with create, select, auto-title, and delete.
- System, light, and dark appearance modes.
- CDP Network capture using protocol 1.3 with 1.2/1.1 fallbacks.
- Tolerant provider parser for JSON, SSE, BOM, control bytes, and proxy text.
- **Cookie Tools** — list, set, import, delete cookies. All cookie values (including HttpOnly and auth tokens) are fully readable and exportable. No domain restrictions on import.

## Install

1. Extract the ZIP.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `open-browser-agent` folder.
6. Reload existing web tabs.
7. Open Settings and enter Base URL, API key, and a tool-capable model.

## API request

```text
POST <base-url>/chat/completions
Authorization: Bearer <api-key>
```

When streaming is enabled, the request contains `stream: true`. Providers may emit normal OpenAI Chat Completions SSE deltas, including `content`, `reasoning_content`, and `tool_calls`.

## Reasoning display

The extension displays only reasoning/thinking text returned by the configured provider. It does not invent or extract hidden reasoning. Stored reasoning is collapsed by default behind **Show reasoning**.

## Privacy

Settings, API credentials, conversations, and appearance are stored in the local Chrome profile. Prompts, selected page content, tool results, and captured Network data may be sent to the endpoint configured by the user.
