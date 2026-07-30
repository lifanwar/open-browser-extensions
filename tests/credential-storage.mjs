import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

import {
  CREDENTIAL_FIELDS,
  CREDENTIAL_PLACEHOLDER,
  ENCRYPTED_CREDENTIALS_KEY,
  clearCredentialFields,
  createSensitiveStreamRedactor,
  decryptCredential,
  encryptCredential,
  getCredentialKey,
  redactSensitiveText
} from "../background/credential-store.js";
import {
  exportSettings,
  importSettings,
  loadRunSettings,
  loadSettings,
  saveSettings
} from "../background/config.js";
import { createChatCompletion } from "../background/openai-client.js";

const cryptoImpl = webcrypto;

globalThis.chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener() {} },
    sendMessage: async () => {}
  },
  debugger: {
    onEvent: { addListener() {} },
    onDetach: { addListener() {} }
  },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  tabs: { onRemoved: { addListener() {} } },
  sidePanel: { setPanelBehavior: async () => {} }
};

const { runAgent } = await import(`../background/agent.js?credential-test=${Date.now()}`);
const { cancelRunState, createRunState, disposeRunState } = await import(
  `../background/service-worker.js?credential-test=${Date.now()}`
);

function createStorage(initial = {}) {
  let state = structuredClone(initial);
  return {
    async get(keys) {
      if (keys == null) return structuredClone(state);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in state).map((key) => [key, structuredClone(state[key])]));
    },
    async set(values) {
      state = { ...state, ...structuredClone(values) };
    },
    snapshot() {
      return structuredClone(state);
    }
  };
}

function createKeyStoreHarness() {
  const values = new Map();
  let opens = 0;
  let closes = 0;
  return {
    openKeyStore: async () => {
      opens += 1;
      let closed = false;
      return {
        async get(id) {
          return values.get(id) || null;
        },
        async add(id, value) {
          if (values.has(id)) {
            const error = new Error("Key already exists");
            error.name = "ConstraintError";
            throw error;
          }
          values.set(id, value);
        },
        close() {
          if (!closed) {
            closed = true;
            closes += 1;
          }
        }
      };
    },
    deleteKey() {
      values.clear();
    },
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    }
  };
}

function options(storage, keyStore) {
  return {
    storage,
    credentialOptions: {
      cryptoImpl,
      openKeyStore: keyStore.openKeyStore
    }
  };
}

function assertNoPlaintext(snapshot, secrets) {
  const serialized = JSON.stringify(snapshot);
  for (const secret of secrets) {
    assert.ok(!serialized.includes(secret), `Plaintext secret leaked into storage/export: ${secret}`);
  }
}

// Fresh installs retain existing non-secret defaults without creating a key.
{
  const storage = createStorage();
  const keyStore = createKeyStoreHarness();
  const fresh = await loadSettings(options(storage, keyStore));
  assert.equal(fresh.baseUrl, "https://api.openai.com/v1");
  assert.equal(fresh.model, "gpt-4.1-mini");
  assert.equal(fresh.apiKey, "");
  assert.equal(keyStore.opens, 0);
}

// AES-256-GCM uses a random non-extractable key and per-value IVs.
{
  const keyStore = createKeyStoreHarness();
  const key = await getCredentialKey({ create: true, cryptoImpl, openKeyStore: keyStore.openKeyStore });
  assert.equal(key.type, "secret");
  assert.equal(key.extractable, false);
  assert.equal(key.algorithm.name, "AES-GCM");
  assert.equal(key.algorithm.length, 256);
  await assert.rejects(() => cryptoImpl.subtle.exportKey("raw", key));
  const first = await encryptCredential("sk-primary", "apiKey", key, cryptoImpl);
  const second = await encryptCredential("sk-primary", "apiKey", key, cryptoImpl);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(await decryptCredential(first, "apiKey", key, cryptoImpl), "sk-primary");
  await assert.rejects(() => decryptCredential(first, "searchApiKey", key, cryptoImpl), /corrupted/i);
  assert.equal(keyStore.opens, keyStore.closes, "Every key-store connection must close");
}

// Streaming redaction holds partial matches so chunk boundaries cannot reconstruct a credential.
{
  const redactor = createSensitiveStreamRedactor(["split-secret"]);
  const output = [redactor.push("before split-"), redactor.push("secret after"), redactor.flush()].join("");
  assert.equal(output, "before [REDACTED API KEY] after");
  assert.ok(!output.includes("split-secret"));
}

// Concurrent first use converges on one persisted key without leaving open connections.
{
  const keyStore = createKeyStoreHarness();
  const [first, second] = await Promise.all([
    getCredentialKey({ create: true, cryptoImpl, openKeyStore: keyStore.openKeyStore }),
    getCredentialKey({ create: true, cryptoImpl, openKeyStore: keyStore.openKeyStore })
  ]);
  assert.equal(first, second);
  assert.equal(keyStore.opens, keyStore.closes);
}

// Saving keeps only encrypted credentials in chrome.storage.local and safe placeholders in UI settings.
{
  const storage = createStorage();
  const keyStore = createKeyStoreHarness();
  const secrets = ["sk-main", "search-secret", "fetch-secret"];
  const saved = await saveSettings({
    baseUrl: "https://api.example.test/v1",
    apiKey: secrets[0],
    model: "test-model",
    enableSearchTool: true,
    searchConnectionMode: "direct",
    searchEndpoint: "https://search.example.test",
    fetchEndpoint: "https://fetch.example.test",
    searchApiKey: secrets[1],
    fetchApiKey: secrets[2]
  }, options(storage, keyStore));

  assert.equal(saved.apiKey, CREDENTIAL_PLACEHOLDER);
  assert.equal(saved.searchApiKey, CREDENTIAL_PLACEHOLDER);
  assert.equal(saved.fetchApiKey, CREDENTIAL_PLACEHOLDER);

  const raw = storage.snapshot();
  assertNoPlaintext(raw, secrets);
  for (const field of CREDENTIAL_FIELDS) assert.ok(!(field in raw.settings));
  assert.equal(raw[ENCRYPTED_CREDENTIALS_KEY].version, 1);

  const runSettings = await loadRunSettings(options(storage, keyStore));
  assert.deepEqual(CREDENTIAL_FIELDS.map((field) => runSettings[field]), secrets);
  const safeSettings = await loadSettings(options(storage, keyStore));
  assert.deepEqual(CREDENTIAL_FIELDS.map((field) => safeSettings[field]), CREDENTIAL_FIELDS.map(() => CREDENTIAL_PLACEHOLDER));
  assert.equal(keyStore.opens, keyStore.closes);
}

// Legacy plaintext is migrated once, then removed from settings storage.
{
  const storage = createStorage({
    settings: {
      baseUrl: "https://api.example.test/v1",
      model: "legacy-model",
      apiKey: "legacy-main",
      searchApiKey: "legacy-search",
      fetchApiKey: ""
    }
  });
  const keyStore = createKeyStoreHarness();
  const safe = await loadSettings(options(storage, keyStore));
  assert.equal(safe.apiKey, CREDENTIAL_PLACEHOLDER);
  assert.equal(safe.searchApiKey, CREDENTIAL_PLACEHOLDER);
  assert.equal(safe.fetchApiKey, "");
  assertNoPlaintext(storage.snapshot(), ["legacy-main", "legacy-search"]);
  const run = await loadRunSettings(options(storage, keyStore));
  assert.equal(run.apiKey, "legacy-main");
  assert.equal(run.searchApiKey, "legacy-search");
}

// The same decrypted settings object is reused across compaction, replanning, tools, and queued instructions.
{
  const settings = {
    baseUrl: "https://api.example.test/v1",
    apiKey: "run-secret",
    model: "test-model",
    streamResponses: false,
    maxToolSteps: 5,
    enableSearchTool: false
  };
  const seenSettings = [];
  const queue = ["Use the queued instruction"];
  let completionIndex = 0;
  const result = await runAgent({
    runId: "secure-run",
    history: [{ role: "user", content: "Start" }],
    settings,
    signal: new AbortController().signal,
    emit: () => {},
    takeQueuedMessages: () => queue.splice(0, queue.length),
    getTargetTab: async () => ({ id: 7 }),
    execute: async () => ({ ok: true }),
    createCompletion: async ({ settings: received, messages }) => {
      seenSettings.push(received);
      completionIndex += 1;
      if (completionIndex === 1) return { role: "assistant", content: "Old final" };
      assert.ok(messages.some((message) => String(message.content || "").includes("queued instruction")));
      return { role: "assistant", content: "Updated final" };
    }
  });
  assert.equal(result.content, "Updated final");
  assert.ok(seenSettings.every((value) => value === settings));
}

// Configured credentials are redacted from provider errors, model output, UI events, and tool transcripts.
{
  const secret = "run-secret-redaction";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: { message: `Provider echoed ${secret}` } }),
    { status: 401, headers: { "content-type": "application/json" } }
  );
  try {
    await assert.rejects(
      () => createChatCompletion({
        settings: { baseUrl: "https://api.example.test/v1", apiKey: secret, model: "m", streamResponses: false },
        messages: [],
        tools: []
      }),
      (error) => !error.message.includes(secret) && error.message.includes("REDACTED")
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const events = [];
  let callIndex = 0;
  const result = await runAgent({
    runId: "redaction-run",
    history: [{ role: "user", content: "Start" }],
    settings: {
      baseUrl: "https://api.example.test/v1",
      apiKey: secret,
      model: "m",
      streamResponses: false,
      maxToolSteps: 3,
      enableSearchTool: false
    },
    signal: new AbortController().signal,
    emit: (event, payload) => events.push({ event, payload }),
    getTargetTab: async () => ({ id: 9 }),
    execute: async () => ({ leaked: secret }),
    createCompletion: async ({ messages, onDelta }) => {
      callIndex += 1;
      if (callIndex === 1) {
        onDelta?.({ type: "reasoning", delta: "Reasoning run-secret-" });
        onDelta?.({ type: "reasoning", delta: "redaction" });
        return {
          role: "assistant",
          reasoning_content: `Reasoning ${secret}`,
          tool_calls: [{ id: "tool-redact", type: "function", function: { name: "read_page", arguments: "{}" } }]
        };
      }
      const transcript = messages.find((message) => message.role === "tool")?.content || "";
      assert.ok(!transcript.includes(secret));
      return { role: "assistant", content: `Final ${secret}` };
    }
  });
  assert.ok(!result.content.includes(secret));
  assert.ok(!result.reasoning.includes(secret));
  assert.ok(!JSON.stringify(events).includes(secret));
}

// Cleanup removes credential references after normal completion, failure, and abort paths.
{
  const successRun = createRunState();
  successRun.settings = { apiKey: "a", searchApiKey: "b", fetchApiKey: "c" };
  disposeRunState(successRun);
  assert.equal(successRun.settings, null);

  const errorRun = createRunState();
  errorRun.settings = { apiKey: "a", searchApiKey: "b", fetchApiKey: "c" };
  disposeRunState(errorRun);
  assert.equal(errorRun.settings, null);

  const abortedRun = createRunState();
  abortedRun.settings = { apiKey: "a", searchApiKey: "b", fetchApiKey: "c" };
  cancelRunState(abortedRun);
  assert.equal(abortedRun.controller.signal.aborted, true);
  assert.equal(abortedRun.settings, null);

  const direct = { apiKey: "a", searchApiKey: "b", fetchApiKey: "c" };
  clearCredentialFields(direct);
  assert.deepEqual(CREDENTIAL_FIELDS.map((field) => direct[field]), ["", "", ""]);
}

// Default export remains encrypted; same-profile import works, failed import is atomic, and legacy plaintext import migrates.
{
  const storage = createStorage();
  const keyStore = createKeyStoreHarness();
  const deps = options(storage, keyStore);
  await saveSettings({ baseUrl: "https://api.example.test/v1", model: "m", apiKey: "export-secret" }, deps);
  const exported = await exportSettings(deps);
  assertNoPlaintext(exported, ["export-secret"]);
  assert.ok(exported.encryptedCredentials.credentials.apiKey.ciphertext);

  const importedStorage = createStorage();
  await importSettings(exported, options(importedStorage, keyStore));
  assert.equal((await loadRunSettings(options(importedStorage, keyStore))).apiKey, "export-secret");

  const beforeFailedImport = importedStorage.snapshot();
  const corrupted = structuredClone(exported);
  corrupted.encryptedCredentials.credentials.apiKey.ciphertext = "not-valid-base64";
  await assert.rejects(() => importSettings(corrupted, options(importedStorage, keyStore)), /cannot be decrypted|corrupted/i);
  assert.deepEqual(importedStorage.snapshot(), beforeFailedImport, "Failed import must not change existing storage");

  const missingKeyStore = createKeyStoreHarness();
  await assert.rejects(() => importSettings(exported, options(createStorage(), missingKeyStore)), /encryption key/i);

  const legacyStorage = createStorage();
  const legacyKeyStore = createKeyStoreHarness();
  await importSettings({ version: 1, settings: { baseUrl: "https://api.example.test/v1", model: "m", apiKey: "legacy-import" } }, options(legacyStorage, legacyKeyStore));
  assertNoPlaintext(legacyStorage.snapshot(), ["legacy-import"]);
  assert.equal((await loadRunSettings(options(legacyStorage, legacyKeyStore))).apiKey, "legacy-import");
}

// Missing key and corrupted ciphertext fail without exposing stored material; all credentials can be replaced safely.
{
  const storage = createStorage();
  const keyStore = createKeyStoreHarness();
  await saveSettings({ baseUrl: "https://api.example.test/v1", model: "m", apiKey: "old-secret" }, options(storage, keyStore));
  keyStore.deleteKey();
  await assert.rejects(() => loadRunSettings(options(storage, keyStore)), /encryption key/i);
  await assert.rejects(() => saveSettings({ baseUrl: "https://api.example.test/v1", model: "m", apiKey: CREDENTIAL_PLACEHOLDER }, options(storage, keyStore)), /re-enter/i);
  await saveSettings({ baseUrl: "https://api.example.test/v1", model: "m", apiKey: "new-secret", searchApiKey: "", fetchApiKey: "" }, options(storage, keyStore));
  assert.equal((await loadRunSettings(options(storage, keyStore))).apiKey, "new-secret");
}

// Short credential word-boundary redaction tests.
{
  // Standalone credential must be redacted.
  assert.equal(redactSensitiveText("Bearer read", ["read"]), "Bearer [REDACTED API KEY]");
  assert.equal(redactSensitiveText("Token: read", ["read"]), "Token: [REDACTED API KEY]");
  assert.equal(redactSensitiveText("read", ["read"]), "[REDACTED API KEY]");

  // Credential inside punctuation must be redacted.
  assert.equal(redactSensitiveText('"read"', ["read"]), '"[REDACTED API KEY]"');
  assert.equal(redactSensitiveText("read,", ["read"]), "[REDACTED API KEY],");
  assert.equal(redactSensitiveText("read.", ["read"]), "[REDACTED API KEY].");
  assert.equal(redactSensitiveText("(read)", ["read"]), "([REDACTED API KEY])");

  // Credential as part of longer word must NOT be redacted.
  assert.equal(redactSensitiveText("reading", ["read"]), "reading");
  assert.equal(redactSensitiveText("reader", ["read"]), "reader");
  assert.equal(redactSensitiveText("alreadyread", ["read"]), "alreadyread");
  assert.equal(redactSensitiveText("readable", ["read"]), "readable");
  assert.equal(redactSensitiveText("my_read_value", ["read"]), "my_read_value");

  // Credential at start and end of string remains redacted.
  assert.equal(redactSensitiveText("read next", ["read"]), "[REDACTED API KEY] next");
  assert.equal(redactSensitiveText("next read", ["read"]), "next [REDACTED API KEY]");

  // Credential with special characters still works.
  assert.equal(redactSensitiveText("use sk-proj-test here", ["sk-proj-test"]), "use [REDACTED API KEY] here");
  assert.equal(redactSensitiveText("sk-proj-testing", ["sk-proj-test"]), "sk-proj-testing");
}

// Streaming redactor word-boundary tests.
{
  // 'reading' split across chunks must not be redacted.
  const r1 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r1.push("Completed after rea"), "Completed after ");
  assert.equal(r1.push("ding. Token: re"), "reading. Token: ");
  assert.equal(r1.push("ad"), "");
  assert.equal(r1.flush(), "[REDACTED API KEY]");

  // Standalone 'read' split across chunks must be redacted.
  const r2 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r2.push("Token: "), "Token: ");
  assert.equal(r2.push("read"), "");
  assert.equal(r2.flush(), "[REDACTED API KEY]");

  // 'reading' as a single chunk must not be redacted.
  const r3 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r3.push("reading"), "reading");
  assert.equal(r3.flush(), "");

  // Flush redacts credential at end of string.
  const r4 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r4.push("use read"), "use ");
  assert.equal(r4.flush(), "[REDACTED API KEY]");

  // Trailing context: 'already' + 'read' must remain 'alreadyread'.
  const r5 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r5.push("already"), "already");
  assert.equal(r5.push("read"), "");          // held at chunk end
  assert.equal(r5.flush(), "read");            // resolved on flush — embedded in word

  // Trailing context: 'my_' + 'read' must remain 'my_read' (_ is word char).
  const r6 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r6.push("my_"), "my_");
  assert.equal(r6.push("read"), "");          // held
  assert.equal(r6.flush(), "read");           // resolved — embedded

  // Trailing context via hold: 'alreadyr' + 'ead' must remain 'alreadyread'.
  const r7 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r7.push("alreadyr"), "already");
  assert.equal(r7.push("ead"), "");           // held ('r' was held from prev, 'ead' completes it)
  assert.equal(r7.flush(), "read");           // resolved — embedded

  // Embedded in single chunk: 'alreadyread' must NOT be redacted.
  const r8 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r8.push("alreadyread"), "already");
  assert.equal(r8.flush(), "read");

  // Mixed: 'xread read' — first 'read' embedded in 'xread', second standalone.
  const r9 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r9.push("xread read"), "xread ");
  assert.equal(r9.flush(), "[REDACTED API KEY]");

  // Cross-chunk adjacent: 'read' + 'read' form 'readread' (one word) -> NOT redacted.
  const r10 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r10.push("read"), "");
  assert.equal(r10.push("read"), "read");    // first half emitted, 'read' held as potential prefix
  assert.equal(r10.flush(), "read");         // held text resolved — embedded

  // Standalone 'read read' — both tokens redacted.
  const r11 = createSensitiveStreamRedactor(["read"]);
  assert.equal(r11.push("read read"), "[REDACTED API KEY] ");
  assert.equal(r11.flush(), "[REDACTED API KEY]");

  // Multiple secrets with overlapping lengths preserve existing behavior.
  const r12 = createSensitiveStreamRedactor(["read", "reader"]);
  assert.equal(r12.push("reader read"), "[REDACTED API KEY] ");
  assert.equal(r12.flush(), "[REDACTED API KEY]");
  const r13 = createSensitiveStreamRedactor(["read", "reader"]);
  assert.equal(r13.push("readers"), "readers");
  assert.equal(r13.flush(), "");
}

console.log("Encrypted credential storage, migration, run reuse, cleanup, import/export, missing-key, corruption checks, and word-boundary redaction passed.");
