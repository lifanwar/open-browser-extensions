import { runAgent } from "./agent.js";
import { loadSettings, saveSettings } from "./config.js";

const activeRuns = new Map();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "GET_SETTINGS":
      return loadSettings();
    case "SAVE_SETTINGS":
      return saveSettings(message.settings || {});
    case "RUN_AGENT":
      return startRun(message);
    case "CANCEL_AGENT":
      return cancelRun(message.runId);
    default:
      throw new Error(`Pesan tidak dikenal: ${message?.type}`);
  }
}

async function startRun(message) {
  const runId = String(message.runId || crypto.randomUUID());
  if (activeRuns.has(runId)) throw new Error("Run ID sedang digunakan.");

  const settings = { ...(await loadSettings()), ...(message.settings || {}) };
  if (!settings.baseUrl) throw new Error("Base URL belum diatur.");
  if (!settings.model) throw new Error("Model belum diatur.");

  const controller = new AbortController();
  activeRuns.set(runId, controller);
  const emit = (event, payload) => {
    chrome.runtime.sendMessage({ type: "AGENT_EVENT", runId, event, payload }).catch(() => {});
  };

  try {
    emit("status", "Agent dimulai.");
    const result = await runAgent({
      runId,
      history: message.history || [],
      settings,
      signal: controller.signal,
      emit
    });
    emit("done", result);
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      emit("cancelled", "Agent dihentikan.");
      throw new Error("Agent dihentikan.");
    }
    emit("error", error?.message || String(error));
    throw error;
  } finally {
    activeRuns.delete(runId);
  }
}

function cancelRun(runId) {
  const controller = activeRuns.get(String(runId));
  if (!controller) return { cancelled: false };
  controller.abort();
  return { cancelled: true };
}
