import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../sidepanel/app.js", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const asyncStart = source.indexOf(`async function ${name}(`);
  const actualStart = asyncStart >= 0 && (start < 0 || asyncStart < start) ? asyncStart : start;
  const end = source.indexOf(`\nfunction ${nextName}(`, actualStart);
  assert.ok(actualStart >= 0 && end > actualStart, `Could not extract ${name}`);
  return source.slice(actualStart, end);
}

const openSettingsSource = functionSource("openSettings", "fillSettingsForm");
const toggleSource = functionSource("setNetworkCaptureFromToggle", "activeTabSubtitle");

assert.match(openSettingsSource, /refreshActiveTab\(\)\.catch/);
assert.doesNotMatch(openSettingsSource, /refreshNetworkCaptureToggle\(\)/);
assert.match(toggleSource, /chrome\.tabs\.query\(\{ active: true, currentWindow: true \}\)/);
assert.doesNotMatch(toggleSource, /activeTab\.id/);

function createHarness({ tab, desired, sendError = "", captureBodies = true }) {
  const queries = [];
  const messages = [];
  const toggle = { checked: desired, disabled: false };
  const status = { textContent: "" };
  let validation = null;
  let refreshes = 0;

  const context = {
    networkCaptureToggle: toggle,
    networkCaptureStatus: status,
    chrome: {
      tabs: {
        query: async (query) => {
          queries.push(query);
          return tab ? [tab] : [];
        }
      }
    },
    sendMessage: async (message) => {
      messages.push(message);
      if (sendError) throw new Error(sendError);
      return { capturing: message.enabled };
    },
    checked: (id) => {
      assert.equal(id, "captureResponseBodies");
      return captureBodies;
    },
    hostname: (url) => {
      try { return new URL(url).hostname; } catch { return ""; }
    },
    showSettingsValidation: (message) => { validation = String(message); },
    refreshActiveTab: async () => {
      refreshes += 1;
      toggle.disabled = !(tab?.id && /^https?:\/\//i.test(tab.url || ""));
    }
  };

  vm.runInNewContext(`${toggleSource}\nglobalThis.runToggle = setNetworkCaptureFromToggle;`, context);

  return {
    run: () => context.runToggle(),
    queries,
    messages,
    toggle,
    status,
    get validation() { return validation; },
    get refreshes() { return refreshes; }
  };
}

// A stale cached tab must not affect the tab selected at click time.
{
  const test = createHarness({
    tab: { id: 401, url: "https://current.example/path" },
    desired: true,
    captureBodies: true
  });
  await test.run();
  assert.deepEqual(JSON.parse(JSON.stringify(test.queries)), [{ active: true, currentWindow: true }]);
  assert.deepEqual(JSON.parse(JSON.stringify(test.messages)), [{
    type: "SET_NETWORK_CAPTURE",
    tabId: 401,
    enabled: true,
    captureBodies: true
  }]);
  assert.equal(test.toggle.checked, true);
  assert.equal(test.toggle.disabled, false);
  assert.equal(test.validation, "");
  assert.equal(test.refreshes, 1);
  assert.match(test.status.textContent, /current\.example/);
}

// OFF must also target the tab active at click time.
{
  const test = createHarness({
    tab: { id: 402, url: "http://off.example/page" },
    desired: false,
    captureBodies: false
  });
  await test.run();
  assert.equal(test.messages[0].tabId, 402);
  assert.equal(test.messages[0].enabled, false);
  assert.equal(test.toggle.checked, false);
  assert.equal(test.toggle.disabled, false);
}

// Restricted pages are rejected before any service-worker command is sent.
{
  const test = createHarness({
    tab: { id: 403, url: "chrome://settings" },
    desired: true
  });
  await test.run();
  assert.equal(test.messages.length, 0);
  assert.equal(test.toggle.checked, false);
  assert.equal(test.toggle.disabled, true);
  assert.match(test.validation, /http\/https/i);
}

// A failed attach rolls the switch back and leaves it usable.
{
  const test = createHarness({
    tab: { id: 404, url: "https://failure.example" },
    desired: true,
    sendError: "Debugger attach failed"
  });
  await test.run();
  assert.equal(test.messages[0].tabId, 404);
  assert.equal(test.toggle.checked, false);
  assert.equal(test.toggle.disabled, false);
  assert.match(test.validation, /attach failed/i);
  assert.equal(test.refreshes, 1);
}

// No active tab is handled without leaving the switch stuck.
{
  const test = createHarness({ tab: null, desired: true });
  await test.run();
  assert.equal(test.messages.length, 0);
  assert.equal(test.toggle.checked, false);
  assert.equal(test.toggle.disabled, true);
  assert.match(test.validation, /http\/https/i);
}

console.log("Network toggle UI tests passed: current-tab ON/OFF, stale-state avoidance, restricted-page rejection, rollback, and no-tab handling.");