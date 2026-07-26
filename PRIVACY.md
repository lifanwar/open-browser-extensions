# Privacy notes

This extension has broad permissions because it must read and operate the current page and optionally inspect Network traffic.

- Chat prompts, selected page content, and tool results are sent to the API endpoint configured by the user.
- API credentials and chat history are stored locally in the Chrome profile using `chrome.storage.local`.
- The extension contains no analytics, advertising, telemetry, or hard-coded external service.
- Network secrets are redacted unless the user enables the sensitive-value setting.
