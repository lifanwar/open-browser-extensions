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
    case "QUEUE_AGENT_MESSAGE":
      return queueRunMessage(message.runId, message.content);
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

  const run = createRunState();
  activeRuns.set(runId, run);
  let emitChain = Promise.resolve();
  const emit = (event, payload) => {
    emitChain = emitChain
      .then(() => chrome.runtime.sendMessage({ type: "AGENT_EVENT", runId, event, payload }))
      .catch(() => {});
  };

  try {
    emit("status", "Agent dimulai.");
    const result = await runAgent({
      runId,
      history: message.history || [],
      contextState: message.contextState || null,
      settings,
      signal: run.controller.signal,
      emit,
      takeQueuedMessages: (options) => takeQueuedMessages(run, options)
    });
    emit("done", result);
    await emitChain;
    return result;
  } catch (error) {
    if (run.controller.signal.aborted) {
      emit("cancelled", "Agent dihentikan.");
      await emitChain;
      throw new Error("Agent dihentikan.");
    }
    emit("error", error?.message || String(error));
    await emitChain;
    throw error;
  } finally {
    run.acceptingMessages = false;
    run.queue.length = 0;
    if (activeRuns.get(runId) === run) activeRuns.delete(runId);
  }
}

function queueRunMessage(runId, rawContent) {
  const id = String(runId || "");
  const run = activeRuns.get(id);
  if (!run) throw new Error("Run aktif tidak ditemukan. Instruksi tidak dimasukkan ke antrean.");

  const queueLength = enqueueRunMessage(run, rawContent);
  return { accepted: true, runId: id, queueLength };
}

function cancelRun(runId) {
  const run = activeRuns.get(String(runId));
  if (!run) return { cancelled: false };
  cancelRunState(run);
  return { cancelled: true };
}

export function createRunState() {
  return {
    controller: new AbortController(),
    queue: [],
    acceptingMessages: true
  };
}

export function enqueueRunMessage(run, rawContent) {
  const content = String(rawContent || "").trim();
  if (!content) throw new Error("Instruksi antrean tidak boleh kosong.");
  if (!run || !run.acceptingMessages || run.controller.signal.aborted) {
    throw new Error("Run sudah tidak aktif. Instruksi tidak dimasukkan ke antrean.");
  }

  run.queue.push(content);
  return run.queue.length;
}

export function takeQueuedMessages(run, { closeIfEmpty = false } = {}) {
  if (!run || run.controller.signal.aborted) return [];
  if (run.queue.length) return run.queue.splice(0, run.queue.length);
  if (closeIfEmpty) run.acceptingMessages = false;
  return [];
}

export function cancelRunState(run) {
  if (!run) return false;
  run.acceptingMessages = false;
  run.queue.length = 0;
  run.controller.abort();
  return true;
}
