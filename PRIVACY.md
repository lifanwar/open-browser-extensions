# Privacy notes

This extension has broad permissions because it must read and operate the current page and optionally inspect Network traffic.

- Chat prompts, selected page content, and tool results are sent to the API endpoint configured by the user.
- API credentials are encrypted with AES-256-GCM before storage. Only ciphertext and IV metadata are kept in `chrome.storage.local`; the non-extractable encryption key is kept in extension IndexedDB. Chat history remains in `chrome.storage.local`.
- The extension contains no analytics, advertising, telemetry, or hard-coded external service.
- Network secrets are redacted unless the user enables the sensitive-value setting.
