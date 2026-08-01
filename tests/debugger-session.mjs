import assert from "node:assert/strict";

const calls = [];
const detachListeners = [];
const eventListeners = [];
const removedListeners = [];
const runtimeGates = new Map();
const detachAttempts = new Map();

function listenerTarget(list) {
  return { addListener(listener) { list.push(listener); } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

globalThis.chrome = {
  debugger: {
    onEvent: listenerTarget(eventListeners),
    onDetach: listenerTarget(detachListeners),
    attach: async ({ tabId }, protocolVersion) => {
      calls.push({ type: "attach", tabId, protocolVersion });
      if (tabId === 205 && protocolVersion === "1.3") {
        throw new Error("Protocol version not supported");
      }
      if (tabId === 206) {
        throw new Error("Another debugger is already attached to the tab");
      }
    },
    detach: async ({ tabId }) => {
      calls.push({ type: "detach", tabId });
      const attempt = (detachAttempts.get(tabId) || 0) + 1;
      detachAttempts.set(tabId, attempt);
      if (tabId === 213 && attempt === 1) throw new Error("Temporary detach transport failure");
    },
    sendCommand: async ({ tabId }, method, params) => {
      calls.push({ type: "command", tabId, method, params });
      if (tabId === 207 && method === "Network.enable") {
        throw new Error("Network domain unavailable");
      }
      if (method === "Runtime.evaluate") {
        const gate = runtimeGates.get(tabId);
        if (gate) {
          gate.started.resolve();
          await gate.release.promise;
        }
        try {
          const value = await Function(`return ${params.expression};`)();
          return { result: { value } };
        } catch (error) {
          return {
            exceptionDetails: {
              text: error.message,
              exception: { description: `${error.name}: ${error.message}` }
            }
          };
        }
      }
      return {};
    }
  },
  tabs: {
    onRemoved: listenerTarget(removedListeners),
    get: async (tabId) => ({ id: tabId, url: `https://tab-${tabId}.example.test/page` })
  }
};

const network = await import(`../background/tools/network-debugger.js?test=${Date.now()}`);
const { executePageScript } = await import(`../background/tools/execute-script.js?test=${Date.now()}`);
const { getDebuggerSessionState } = await import("../background/tools/debugger-session.js");

const count = (type, tabId, method) => calls.filter((call) =>
  call.type === type
  && call.tabId === tabId
  && (method === undefined || call.method === method)
).length;

// executeScript by itself owns a short-lived session.
{
  const result = await executePageScript(201, "const x = 20; x + 22");
  assert.deepEqual(result, { ok: true, result: 42 });
  assert.equal(count("attach", 201), 1);
  assert.equal(count("command", 201, "Runtime.evaluate"), 1);
  assert.equal(count("detach", 201), 1);
  assert.equal(getDebuggerSessionState(201).attached, false);
}

// Network and executeScript share one attachment; script completion must not stop capture.
{
  const started = await network.startNetwork(202, { captureBodies: true });
  assert.equal(started.capturing, true);
  const result = await executePageScript(202, "40 + 2");
  assert.deepEqual(result, { ok: true, result: 42 });
  assert.equal(count("attach", 202), 1);
  assert.equal(count("detach", 202), 0);
  assert.equal(network.getNetworkState(202).capturing, true);
  assert.equal(getDebuggerSessionState(202).consumers, 1);

  const stopped = await network.stopNetwork(202);
  assert.equal(stopped.capturing, false);
  assert.equal(stopped.attached, false);
  assert.equal(count("command", 202, "Network.disable"), 1);
  assert.equal(count("detach", 202), 1);
}

// Concurrent first use still attaches only once.
{
  const [started, result] = await Promise.all([
    network.startNetwork(203),
    executePageScript(203, "21 * 2")
  ]);
  assert.equal(started.capturing, true);
  assert.deepEqual(result, { ok: true, result: 42 });
  assert.equal(count("attach", 203), 1);
  assert.equal(count("detach", 203), 0);
  await network.stopNetwork(203);
  assert.equal(count("detach", 203), 1);
}

// Turning Network off during a running script must not detach the script's session.
{
  const gate = { started: deferred(), release: deferred() };
  runtimeGates.set(204, gate);
  await network.startNetwork(204);
  const execution = executePageScript(204, "40 + 2");
  await gate.started.promise;

  const stopped = await network.stopNetwork(204);
  assert.equal(stopped.capturing, false);
  assert.equal(stopped.attached, true);
  assert.equal(count("detach", 204), 0);
  assert.equal(getDebuggerSessionState(204).consumers, 1);

  gate.release.resolve();
  assert.deepEqual(await execution, { ok: true, result: 42 });
  runtimeGates.delete(204);
  assert.equal(count("detach", 204), 1);
  assert.equal(getDebuggerSessionState(204).attached, false);
}

// Protocol fallback is centralized in the shared manager.
{
  const started = await network.startNetwork(205);
  assert.equal(started.protocolVersion, "1.2");
  assert.equal(count("attach", 205), 2);
  await network.stopNetwork(205);
}

// A real external debugger conflict remains a clean user-facing error, not a false success.
{
  const result = await executePageScript(206, "40 + 2");
  assert.equal(result.ok, false);
  assert.match(result.error, /DevTools or another debugger/i);
  assert.equal(count("command", 206, "Runtime.evaluate"), 0);
  assert.equal(count("detach", 206), 0);
}

// Network.enable failure releases the acquired session and does not leave stale capture state.
{
  await assert.rejects(() => network.startNetwork(207), /Network domain unavailable/);
  assert.equal(network.getNetworkState(207).capturing, false);
  assert.equal(getDebuggerSessionState(207).attached, false);
  assert.equal(count("detach", 207), 1);
}

// Parser failure happens before debugger attachment.
{
  const result = await executePageScript(208, "const = 42");
  assert.equal(result.ok, false);
  assert.match(result.error, /Unexpected/);
  assert.equal(count("attach", 208), 0);
}

// Unexpected detach clears both session ownership and Network state.
{
  await network.startNetwork(209);
  for (const listener of detachListeners) listener({ tabId: 209 }, "replaced_with_devtools");
  assert.equal(getDebuggerSessionState(209).attached, false);
  assert.equal(getDebuggerSessionState(209).consumers, 0);
  assert.equal(network.getNetworkState(209).capturing, false);
  await network.stopNetwork(209);
  assert.equal(count("detach", 209), 0);
}

// Per-tab sessions remain isolated.
{
  await Promise.all([network.startNetwork(210), network.startNetwork(211)]);
  assert.equal(count("attach", 210), 1);
  assert.equal(count("attach", 211), 1);
  await network.stopNetwork(210);
  assert.equal(network.getNetworkState(210).capturing, false);
  assert.equal(network.getNetworkState(211).capturing, true);
  assert.equal(getDebuggerSessionState(211).attached, true);
  await network.stopNetwork(211);
}

// Closing a tab prunes both state maps.
{
  await network.startNetwork(212);
  for (const listener of removedListeners) listener(212);
  assert.equal(getDebuggerSessionState(212).attached, false);
  assert.equal(network.getNetworkState(212).capturing, false);
}

// A transient detach failure keeps the truthful attached state, then self-heals on the next release.
{
  const first = await executePageScript(213, "40 + 2");
  assert.deepEqual(first, { ok: true, result: 42 });
  assert.equal(getDebuggerSessionState(213).attached, true);
  assert.equal(getDebuggerSessionState(213).consumers, 0);
  assert.equal(count("attach", 213), 1);

  const second = await executePageScript(213, "21 * 2");
  assert.deepEqual(second, { ok: true, result: 42 });
  assert.equal(count("attach", 213), 1, "live session should be reused instead of falsely re-attached");
  assert.equal(count("detach", 213), 2);
  assert.equal(getDebuggerSessionState(213).attached, false);
}

console.log("Shared debugger session tests passed: single attachment, concurrent ownership, safe Network toggle, protocol fallback, cleanup failures, external detach, and tab isolation.");
