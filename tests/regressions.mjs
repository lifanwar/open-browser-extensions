import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function listenerTarget(capture) {
  return { addListener(listener) { capture(listener); } };
}

let serviceWorkerMessageListener;
globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    getURL: (value = "") => `chrome-extension://test-extension-id/${value}`,
    onInstalled: listenerTarget(() => {}),
    onStartup: listenerTarget(() => {}),
    onMessage: listenerTarget((listener) => { serviceWorkerMessageListener = listener; }),
    sendMessage: async () => ({})
  },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    onEvent: listenerTarget(() => {}),
    onDetach: listenerTarget(() => {}),
    attach: async () => {},
    detach: async () => {},
    sendCommand: async () => ({})
  },
  tabs: {
    onRemoved: listenerTarget(() => {}),
    onUpdated: listenerTarget(() => {}),
    query: async () => [],
    sendMessage: async () => undefined
  },
  cookies: {
    getAll: async () => [],
    set: async () => null,
    remove: async () => null
  }
};

const {
  redactSensitiveValue
} = await import(`../background/credential-store.js?regression=${Date.now()}`);
const {
  prepareConversationContext,
  sanitizeConversationHistory
} = await import(`../background/context-compaction.js?regression=${Date.now()}`);
const { createChatCompletion } = await import(`../background/openai-client.js?regression=${Date.now()}`);
const { runAgent } = await import(`../background/agent.js?regression=${Date.now()}`);
const { executeTool } = await import(`../background/tools/browser-tools.js?regression=${Date.now()}`);
await import(`../background/service-worker.js?regression=${Date.now()}`);

function dispatchServiceWorkerMessage(message, sender) {
  return new Promise((resolve) => {
    const keepAlive = serviceWorkerMessageListener(message, sender, resolve);
    assert.equal(keepAlive, true);
  });
}

// Credential reveal is available only to the extension side panel.
{
  const denied = await dispatchServiceWorkerMessage(
    { type: "REVEAL_CREDENTIAL", field: "apiKey" },
    {
      id: chrome.runtime.id,
      url: "https://example.test/page",
      tab: { id: 1 }
    }
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /side panel/i);

  const allowed = await dispatchServiceWorkerMessage(
    { type: "REVEAL_CREDENTIAL", field: "apiKey" },
    {
      id: chrome.runtime.id,
      url: chrome.runtime.getURL("sidepanel/index.html")
    }
  );
  assert.deepEqual(allowed, { ok: true, result: "" });
}

// A content script that fails to return a response produces a useful error.
{
  chrome.tabs.sendMessage = async () => undefined;
  await assert.rejects(
    () => executeTool("read_page", {}, {
      targetTabId: 5,
      settings: {},
      emit: () => {}
    }),
    /did not send a response for READ_PAGE/i
  );
}

// Repeated references are not cycles, while real cycles remain safely marked.
{
  const shared = { value: "shared-secret" };
  const redacted = redactSensitiveValue({ first: shared, second: shared }, ["shared-secret"]);
  assert.deepEqual(redacted, {
    first: { value: "[REDACTED API KEY]" },
    second: { value: "[REDACTED API KEY]" }
  });

  const circular = { value: "shared-secret" };
  circular.self = circular;
  assert.deepEqual(redactSensitiveValue(circular, ["shared-secret"]), {
    value: "[REDACTED API KEY]",
    self: "[Circular]"
  });
}

// Redaction must not change fallback IDs used as compaction boundaries.
{
  const secret = "boundary-secret";
  const history = [
    { role: "user", content: `Older ${secret} message`, createdAt: 10 },
    { role: "assistant", content: "Newer retained message", createdAt: 20 }
  ];
  const boundary = sanitizeConversationHistory(history)[0].id;
  const prepared = await prepareConversationContext({
    history,
    contextState: {
      version: 1,
      summary: `Summary without ${secret} disclosure`,
      compactedThroughId: boundary,
      updatedAt: 1
    },
    settings: { apiKey: secret }
  });

  assert.equal(prepared.messages.length, 2);
  assert.match(prepared.messages[0].content, /^\[Compacted conversation memory\]/);
  assert.equal(prepared.messages[1].content, "Newer retained message");
  assert.ok(!JSON.stringify(prepared).includes(secret));
}

// A short credential collision must not mutate provider tool names or arguments.
{
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "call-read",
          type: "function",
          function: {
            name: "read_page",
            arguments: JSON.stringify({ url: "https://read.example.test" })
          }
        }]
      }
    }]
  }), { status: 200, headers: { "content-type": "application/json" } });

  try {
    const message = await createChatCompletion({
      settings: {
        baseUrl: "https://api.example.test/v1",
        apiKey: "read",
        model: "test-model",
        streamResponses: false
      },
      messages: [],
      tools: []
    });
    assert.equal(message.tool_calls[0].function.name, "read_page");
    assert.equal(JSON.parse(message.tool_calls[0].function.arguments).url, "https://read.example.test");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// Tool calls remain intact in the transcript, and an undefined tool result is serialized as null.
{
  let completion = 0;
  const executed = [];
  const result = await runAgent({
    runId: "tool-regression",
    history: [{ role: "user", content: "Read the page" }],
    settings: {
      apiKey: "read",
      maxToolSteps: 2,
      enableSearchTool: false,
      allowCookieWrites: false
    },
    signal: new AbortController().signal,
    emit: () => {},
    getTargetTab: async () => ({ id: 7 }),
    execute: async (name, args) => {
      executed.push({ name, args });
      return undefined;
    },
    createCompletion: async ({ messages }) => {
      completion += 1;
      if (completion === 1) {
        return {
          role: "assistant",
          tool_calls: [{
            id: "tool-read",
            type: "function",
            function: { name: "read_page", arguments: "{}" }
          }]
        };
      }
      const assistantToolCall = messages.find((message) => message.role === "assistant" && message.tool_calls);
      assert.equal(assistantToolCall.tool_calls[0].function.name, "read_page");
      const toolResult = messages.find((message) => message.role === "tool");
      assert.equal(toolResult.content, "null");
      return { role: "assistant", content: "Completed" };
    }
  });

  assert.deepEqual(executed, [{ name: "read_page", args: {} }]);
  assert.equal(result.content, "Completed");
}

function createContentHarness() {
  let messageListener;
  const clickState = { count: 0 };
  const scrollState = { behavior: "", count: 0 };

  class HTMLElement {
    constructor(tagName = "div") {
      this.tagName = tagName.toUpperCase();
      this.isConnected = true;
      this.innerText = "";
      this.textContent = "";
      this.scrollHeight = 1000;
      this.attributes = new Map();
    }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    matches() { return false; }
    getBoundingClientRect() { return { width: 100, height: 30, x: 5, y: 10 }; }
    scrollIntoView() {}
    focus() {}
    click() { clickState.count += 1; }
    dispatchEvent() { return true; }
    scrollTo(options) { scrollState.behavior = options?.behavior || ""; scrollState.count += 1; }
    scrollBy(options) { scrollState.behavior = options?.behavior || ""; scrollState.count += 1; }
  }
  class HTMLButtonElement extends HTMLElement {
    constructor() { super("button"); this.innerText = "Continue"; }
  }
  class HTMLAnchorElement extends HTMLElement {}
  class HTMLInputElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {}
  class HTMLSelectElement extends HTMLElement {}

  const button = new HTMLButtonElement();
  const bodyClone = {
    innerText: "Visible page text",
    textContent: "Visible page text",
    querySelectorAll: () => []
  };
  const document = {
    title: "Regression page",
    body: { cloneNode: () => bodyClone },
    documentElement: { scrollHeight: 2000 },
    activeElement: null,
    querySelectorAll: () => [button]
  };

  const context = {
    chrome: {
      runtime: {
        onMessage: {
          addListener(listener) { messageListener = listener; }
        }
      }
    },
    document,
    location: { href: "https://example.test/current" },
    innerWidth: 1280,
    innerHeight: 720,
    scrollX: 0,
    scrollY: 0,
    HTMLElement,
    HTMLButtonElement,
    HTMLAnchorElement,
    HTMLInputElement,
    HTMLTextAreaElement,
    HTMLSelectElement,
    Event,
    InputEvent: class InputEvent extends Event {},
    KeyboardEvent: class KeyboardEvent extends Event {},
    getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    setTimeout,
    clearTimeout
  };
  context.window = context;
  context.scrollTo = (options) => {
    scrollState.behavior = options?.behavior || "";
    scrollState.count += 1;
    context.scrollY = Number(options?.top || 0);
  };
  context.scrollBy = (options) => {
    scrollState.behavior = options?.behavior || "";
    scrollState.count += 1;
    context.scrollY += Number(options?.top || 0);
  };

  const source = fs.readFileSync(path.join(root, "content/browser.js"), "utf8");
  vm.runInContext(source, vm.createContext(context));

  return {
    clickState,
    scrollState,
    send(message) {
      return new Promise((resolve) => {
        const keepAlive = messageListener(message, {}, resolve);
        assert.equal(keepAlive, true);
      });
    }
  };
}

// Content messaging returns structured responses and keeps main's interaction settle time.
{
  const harness = createContentHarness();
  const page = await harness.send({ type: "READ_PAGE" });
  assert.equal(page.ok, true);
  assert.equal(page.elements[0].ref, "e1");

  const clickStarted = Date.now();
  const clicked = await harness.send({ type: "CLICK", ref: "e1" });
  assert.equal(clicked.ok, true);
  assert.equal(harness.clickState.count, 1);
  assert.ok(Date.now() - clickStarted >= 300, "Click response must wait for the page to settle");

  const scrollStarted = Date.now();
  const scrolled = await harness.send({ type: "SCROLL", direction: "down", amount: 200 });
  assert.equal(scrolled.ok, true);
  assert.equal(harness.scrollState.behavior, "smooth");
  assert.ok(Date.now() - scrollStarted >= 400, "Scroll response must wait for smooth scrolling");

  const stale = await harness.send({ type: "CLICK", ref: "missing" });
  assert.equal(stale.ok, false);
  assert.match(stale.error, /tidak valid/i);
}

function extractFunction(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `Unable to extract ${startMarker}`);
  return source.slice(start, end);
}

// Showing or hiding a credential never overwrites an unsaved value.
{
  const source = fs.readFileSync(path.join(root, "sidepanel/app.js"), "utf8");
  const functionSource = extractFunction(
    source,
    "async function togglePasswordVisibility",
    "\nfunction resetPasswordField"
  );

  const input = { type: "password", value: "new-unsaved-key" };
  const button = {
    ariaLabel: "Show API key",
    setAttribute(name, value) { if (name === "aria-label") this.ariaLabel = value; }
  };
  let reveal = async () => "stored-key";
  const context = vm.createContext({
    document: { querySelector: () => input },
    sendMessage: (...args) => reveal(...args)
  });
  vm.runInContext(`${functionSource}\nglobalThis.togglePasswordVisibility = togglePasswordVisibility;`, context);

  await context.togglePasswordVisibility("apiKey", button, "API key");
  assert.equal(input.type, "text");
  assert.equal(input.value, "new-unsaved-key");
  await context.togglePasswordVisibility("apiKey", button, "API key");
  assert.equal(input.type, "password");
  assert.equal(input.value, "new-unsaved-key");

  input.type = "password";
  input.value = "";
  await context.togglePasswordVisibility("apiKey", button, "API key");
  assert.equal(input.type, "text");
  assert.equal(input.value, "");

  input.type = "password";
  input.value = "••••••••";
  reveal = async () => "stored-key";
  await context.togglePasswordVisibility("apiKey", button, "API key");
  assert.equal(input.type, "text");
  assert.equal(input.value, "stored-key");

  input.type = "password";
  input.value = "••••••••";
  button.ariaLabel = "Show API key";
  reveal = async () => { throw new Error("decrypt failed"); };
  await context.togglePasswordVisibility("apiKey", button, "API key");
  assert.equal(input.type, "password");
  assert.equal(input.value, "••••••••");
  assert.equal(button.ariaLabel, "Show API key");
}

// The lifecycle fix must check cancellation before assigning decrypted settings,
// while preserving main-compatible per-run overrides.
{
  const source = fs.readFileSync(path.join(root, "background/service-worker.js"), "utf8");
  const loadIndex = source.indexOf("const loadedSettings = await loadRunSettings()");
  const abortIndex = source.indexOf("if (run.controller.signal.aborted)", loadIndex);
  const assignIndex = source.indexOf("run.settings = { ...loadedSettings, ...(message.settings || {}) }", loadIndex);
  assert.ok(loadIndex >= 0 && abortIndex > loadIndex && assignIndex > abortIndex);
  assert.match(source, /clearCredentialFields\(loadedSettings\)/);
}

console.log("Feature/refactor regression checks passed.");
