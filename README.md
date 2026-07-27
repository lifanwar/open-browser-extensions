# Open Browser Agent

A clean, non-obfuscated Chrome Manifest V3 browser agent with a Merlin-style side panel, your own OpenAI-compatible endpoint, native function tools, streaming, conversations, reasoning panels, and dark mode.

## Highlights

* Clean HTML, CSS, and JavaScript source with no bundler or minification.
* OpenAI-compatible `POST /chat/completions` integration.
* Native `tools` / `tool_calls` browser-agent loop.
* SSE and NDJSON streaming with incremental answer rendering.
* Provider reasoning trace support, hidden behind a collapsible button by default.
* Multiple locally stored conversations with create, select, auto-title, and delete.
* System, light, and dark appearance modes.
* CDP Network capture using protocol 1.3 with 1.2/1.1 fallbacks.
* Tolerant provider parser for JSON, SSE, BOM, control bytes, and proxy text.
* **Cookie Tools** — list, set, import, delete cookies. All cookie values (including HttpOnly and auth tokens) are fully readable and exportable. No domain restrictions on import.
* **Web Search Tools** — optional `SEARCH` and `EXTRACT` tools with Direct Endpoint and 9Router-compatible connections.

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

## Web Search Tools

Enable **Web search tool** from **Settings → Browser tools**, then configure **Search Connection**.

* **9Router-compatible** uses `<base-url>/search` and `<base-url>/web/fetch`.
* **Direct endpoints** uses separate Search and Fetch endpoint URLs.
* Search and Fetch use separate API keys and models.
* Public web queries use `SEARCH`, while known URLs use `EXTRACT`.
* Browser navigation remains available for clicks, forms, login, and other direct interaction.

## Reasoning display

The extension displays only reasoning/thinking text returned by the configured provider. It does not invent or extract hidden reasoning. Model steps and tool calls are shown in an expandable activity timeline attached to the assistant message.

## Privacy

Settings, API credentials, conversations, and appearance are stored in the local Chrome profile. Prompts, selected page content, tool results, search queries, fetched URLs, and captured Network data may be sent to the endpoints configured by the user.
::: 

