# Changelog

## 1.6.0

- Added credential encryption, SEARCH/EXTRACT tools, Network Debugger, credential reveal, and streaming with reasoning.
- Refactored redaction into an upper layer and moved tool files into `background/tools/`.
- Removed deprecated search-tools in favor of the new credential reveal handler.
- Translated all user-facing messages from Indonesian to English.
- Simplified Configuration, Context, and Privacy docs; rewrote Core Features; restored Ctrl+M shortcut.

## 1.5.2

- Fixed memory leaks in network debugger: prunes per-tab state on tab close so `states` Map doesn't grow unbounded.
- Truncated network response bodies at storage time (200KB) instead of serialization time, preventing raw body accumulation in memory.
- Guarded `showCopiedState` timer against detached DOM nodes — skips restore if the button was removed from the tree (e.g. chat re-render).
- Fixed `executeScript` always returning `null` because the async IIFE was missing `return` before the evaluated code.

## 1.5.1

- Added dependency-free syntax highlighting for code blocks with toolbar, language label, and copy button.
- Added reusable `writeClipboard` + `showCopiedState` copy helpers for code blocks and tables.
- Enhanced code block presentation with dark-themed styling, rounded corners, and shadow.
- Added copy button to pipe tables for table-as-text export.
- General naming cleanup.

## 1.5.0

- Added rolling per-conversation context compaction for long chats.
- Kept the complete UI conversation history local while sending compact memory and recent turns to the model.
- Added stable message IDs so compaction boundaries survive saving, reopening, and front-pruning of old messages.
- Added a provider-safe fallback that preserves the previous full-history behavior when summarization is unavailable.
- Omitted `tools` and `tool_choice` from summary-only Chat Completions requests.
- Added context-compaction, persistence, no-tools request, and regression tests.

## 1.4.0

- Added Web Search Tools (SEARCH & EXTRACT) for public web research and URL content extraction.
- Added search-tools.js — search & fetch client with 9Router-compatible and Direct endpoint modes.
- Added search-tool.js — search tool execution and result summarization logic.
- Added styles.css — search UI styling in the sidepanel.
- Added search configuration (enable/disable, endpoint, API key) in Settings.
- Integrated search UI into sidepanel with mode toggle and result display.
- Updated agent system prompt with SEARCH_TOOL_SYSTEM_POLICY for tool selection rules.
- Updated tool-definitions.js to register web_search_tool in the tool list.

## 1.3.3

- Moved live agent activity out of the composer area and into each assistant message.
- Added a Merlin-style activity timeline with running Thought process steps, ordered tool calls, and Running, Done, Failed, or Stopped states.
- Added expandable tool rows for arguments and concise results.
- Persisted activity timelines with conversation history.
- Added stable tool-call IDs so repeated calls to the same tool are updated independently.
- Removed the legacy activity box above the input.
- Preserved manual scroll position by auto-scrolling only when the chat is within 100 pixels of the bottom.

## 1.3.2

- Removed all cookie value redaction: HttpOnly and auth/session/token cookies are now fully readable and exportable.
- Removed import restrictions: HttpOnly cookies, auth cookies, and cross-domain cookies are no longer rejected. Max 100 limit removed.
- Removed delete-all confirmation requirement.
- Added markdown pipe table rendering with horizontal scroll wrapper.

## 1.3.1

- Fixed API runs when Allow cookie paste/delete is disabled by omitting unavailable cookie-write schemas from the request.
- Made the cookies_set function schema strict for broader OpenAI-compatible provider support.
- Rebuilt Settings as a fixed header/footer dialog with an independently scrolling body.
- Fixed switch focus positioning that could jump the Settings panel and leave a blank area.

## 1.3.0

- Added current-page cookie tools: list/export cookies, create/update, JSON import, delete one, and delete all.
- Added cookies permission and a Settings switch for cookie write operations.
- Cookie operations are scoped to the active page host.

## 1.2.0

- Fixed debugger attach failures caused by required protocol version 0.1.
- Added CDP protocol 1.3 with 1.2 and 1.1 fallback attempts.
- Added real-time SSE/NDJSON answer streaming.
- Added streamed provider reasoning/thinking trace support.
- Added collapsed Show reasoning / Hide reasoning panels.
- Added local multi-conversation storage, migration, switching, creation, auto-title, and deletion.
- Added system, light, and dark appearance modes.
- Added streaming UI caret and live reasoning updates.
- Expanded validation for protocol version, streaming deltas, conversations, and UI controls.

## 1.1.0

- Rebuilt the side-panel interface in a clean Merlin-style layout.
- Replaced the account/profile position with local API Settings.
- Added a tolerant parser for OpenAI-compatible providers.

## 1.0.0

- Initial clean-source browser agent.
