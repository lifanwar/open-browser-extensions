# Changelog

## 1.2.0

- Fixed debugger attach failures caused by required protocol version `0.1`.
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

## 1.3.0
- Added current-page cookie tools: list/export regular cookies, create/update, JSON import, delete one, and delete all.
- Added `cookies` permission and a Settings switch for cookie write operations.
- Cookie operations are scoped to the active page host.
- HttpOnly and authentication/session/token-like cookie values are redacted and cannot be imported.


## 1.3.1
- Fixed API runs when Allow cookie paste/delete is disabled by omitting unavailable cookie-write schemas from the request.
- Made the cookies_set function schema strict for broader OpenAI-compatible provider support.
- Rebuilt Settings as a fixed header/footer dialog with an independently scrolling body.
- Fixed switch focus positioning that could jump the Settings panel and leave a blank area.
