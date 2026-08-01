import assert from "node:assert/strict";

let messageListener;
const calls = [];
const tabs = new Map([
  [301, { id: 301, url: "https://example.test/page", active: true }],
  [302, { id: 302, url: "chrome://settings", active: false }]
]);

function listenerTarget(capture = () => {}) {
  return { addListener(listener) { capture(listener); } };
}

globalThis.chrome = {
  runtime: {
    id: "test-extension-id",
    getURL: (value = "") => `chrome-extension://test-extension-id/${value}`,
    onInstalled: listenerTarget(),
    onStartup: listenerTarget(),
    onMessage: listenerTarget((listener) => { messageListener = listener; }),
    sendMessage: async () => ({})
  },
  sidePanel: { setPanelBehavior: async () => {} },
  storage: {
    local: {
      get: async () => ({ settings: { autoStartNetwork: true, captureResponseBodies: true } }),
      set: async () => {}
    }
  },
  debugger: {
    onEvent: listenerTarget(),
    onDetach: listenerTarget(),
    attach: async ({ tabId }, protocolVersion) => calls.push({ type: "attach", tabId, protocolVersion }),
    detach: async ({ tabId }) => calls.push({ type: "detach", tabId }),
    sendCommand: async ({ tabId }, method) => {
      calls.push({ type: "command", tabId, method });
      return {};
    }
  },
  tabs: {
    onRemoved: listenerTarget(),
    onUpdated: listenerTarget(),
    get: async (tabId) => {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("No tab");
      return tab;
    },
    query: async () => [...tabs.values()].filter((tab) => tab.active),
    sendMessage: async (_tabId, message) => ({ type: message.type, ok: true }),
    update: async () => ({})
  },
  cookies: {
    getAll: async () => [],
    set: async () => null,
    remove: async () => null
  }
};

await import(`../background/service-worker.js?toggle=${Date.now()}`);
const { executeTool } = await import("../background/tools/browser-tools.js");

function dispatch(message, sender) {
  return new Promise((resolve) => {
    const keepAlive = messageListener(message, sender, resolve);
    assert.equal(keepAlive, true);
  });
}

const sidepanelSender = {
  id: chrome.runtime.id,
  url: chrome.runtime.getURL("sidepanel/index.html")
};

// Legacy auto-start data is removed from public settings rather than silently kept.
{
  const response = await dispatch({ type: "GET_SETTINGS" }, sidepanelSender);
  assert.equal(response.ok, true);
  assert.equal(Object.hasOwn(response.result, "autoStartNetwork"), false);
}

// read_page never attaches a debugger, even if a stale caller still sends the retired setting.
{
  const before = calls.length;
  const result = await executeTool("read_page", {}, {
    targetTabId: 301,
    settings: { autoStartNetwork: true, captureResponseBodies: true },
    emit: () => {}
  });
  assert.deepEqual(result, { type: "READ_PAGE", ok: true });
  assert.equal(calls.length, before);
}

// Network controls are restricted to the extension side panel.
{
  const denied = await dispatch(
    { type: "SET_NETWORK_CAPTURE", tabId: 301, enabled: true },
    { id: chrome.runtime.id, url: "https://example.test", tab: { id: 301 } }
  );
  assert.equal(denied.ok, false);
  assert.match(denied.error, /side panel/i);
}

// ON/OFF acts as an idempotent live toggle for the selected tab.
{
  const started = await dispatch(
    { type: "SET_NETWORK_CAPTURE", tabId: 301, enabled: true, captureBodies: true },
    sidepanelSender
  );
  assert.equal(started.ok, true);
  assert.equal(started.result.capturing, true);
  assert.equal(calls.filter((call) => call.type === "attach" && call.tabId === 301).length, 1);
  assert.equal(calls.filter((call) => call.method === "Network.enable" && call.tabId === 301).length, 1);

  const startedAgain = await dispatch(
    { type: "SET_NETWORK_CAPTURE", tabId: 301, enabled: true, captureBodies: false },
    sidepanelSender
  );
  assert.equal(startedAgain.result.capturing, true);
  assert.equal(startedAgain.result.captureBodies, false);
  assert.equal(calls.filter((call) => call.type === "attach" && call.tabId === 301).length, 1);
  assert.equal(calls.filter((call) => call.method === "Network.enable" && call.tabId === 301).length, 1);

  const state = await dispatch({ type: "GET_NETWORK_STATE", tabId: 301 }, sidepanelSender);
  assert.equal(state.result.capturing, true);

  const stopped = await dispatch(
    { type: "SET_NETWORK_CAPTURE", tabId: 301, enabled: false },
    sidepanelSender
  );
  assert.equal(stopped.result.capturing, false);
  assert.equal(stopped.result.attached, false);
  assert.equal(calls.filter((call) => call.method === "Network.disable" && call.tabId === 301).length, 1);
  assert.equal(calls.filter((call) => call.type === "detach" && call.tabId === 301).length, 1);

  const stoppedAgain = await dispatch(
    { type: "SET_NETWORK_CAPTURE", tabId: 301, enabled: false },
    sidepanelSender
  );
  assert.equal(stoppedAgain.result.capturing, false);
  assert.equal(calls.filter((call) => call.type === "detach" && call.tabId === 301).length, 1);
}

// Restricted pages cannot be toggled.
{
  const response = await dispatch(
    { type: "SET_NETWORK_CAPTURE", tabId: 302, enabled: true },
    sidepanelSender
  );
  assert.equal(response.ok, false);
  assert.match(response.error, /http\/https/i);
}

console.log("Manual Network toggle tests passed: no auto-start, side-panel authorization, idempotent ON/OFF, live body-capture update, and restricted-page rejection.");
